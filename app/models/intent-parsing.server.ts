/**
 * LLM-powered intent parsing for EditMuse
 * 
 * Uses OpenAI to understand user queries and extract structured intent,
 * replacing fragile regex-based pattern matching with natural language understanding.
 * 
 * Industry-agnostic: Works for any product catalog without hardcoded categories.
 */

const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";

interface ParsedIntent {
  isBundle: boolean;
  hardTerms: string[];
  softTerms: string[];
  avoidTerms: string[];
  hardFacets: {
    size: string | null;
    color: string | null;
    material: string | null;
  };
  bundleItems?: Array<{
    hardTerms: string[];
    quantity: number;
    constraints?: {
      optionConstraints?: {
        size?: string | null;
        color?: string | null;
        material?: string | null;
      };
      priceCeiling?: number | null;
      includeTerms?: string[];
      excludeTerms?: string[];
    };
  }>;
  totalBudget: number | null;
  totalBudgetCurrency: string | null;
  preferences?: string[]; // Style/preference terms (e.g., "plain", "wireless", "organic")
}

interface IntentParseResult {
  success: boolean;
  intent?: ParsedIntent;
  error?: string;
  fallbackUsed?: boolean;
}

const DEFAULT_MODEL = "gpt-4o-mini";
const INTENT_PARSE_TIMEOUT_MS = 10000; // 10 seconds for intent parsing

/**
 * Build JSON schema for structured intent output
 */
function buildIntentSchema() {
  return {
    type: "object",
    properties: {
      isBundle: {
        type: "boolean",
        description: "True if user is requesting multiple distinct product items (e.g., 'laptop and mouse', 'sofa and table', 'suit and shirt'), false for single item queries"
      },
      hardTerms: {
        type: "array",
        items: { type: "string" },
        description: "Concrete product terms and attributes that must match (e.g., 'blue', 'shirt', 'laptop', 'wireless', 'cotton', 'organic'). These are specific, searchable terms. Industry-agnostic."
      },
      softTerms: {
        type: "array",
        items: { type: "string" },
        description: "Abstract concepts, context, or preferences that guide selection but aren't concrete search terms (e.g., 'formal', 'casual', 'work')"
      },
      avoidTerms: {
        type: "array",
        items: { type: "string" },
        description: "Terms that should be excluded (e.g., 'no prints', 'avoid floral', 'not red')"
      },
      hardFacets: {
        type: "object",
        properties: {
          size: { type: ["string", "null"], description: "Size constraint if specified (e.g., 'Large', 'XL')" },
          color: { type: ["string", "null"], description: "Color constraint if specified (e.g., 'Blue', 'Red')" },
          material: { type: ["string", "null"], description: "Material constraint if specified (e.g., 'Cotton', 'Leather')" }
        },
        required: ["size", "color", "material"],
        additionalProperties: false
      },
      bundleItems: {
        type: "array",
        items: {
          type: "object",
          properties: {
            hardTerms: {
              type: "array",
              items: { type: "string" },
              description: "Product terms for this bundle item (e.g., ['suit'], ['laptop'], ['sofa']). Industry-agnostic - works for any product type."
            },
            quantity: {
              type: "number",
              description: "Quantity requested for this item (default: 1)"
            },
            constraints: {
              type: "object",
              properties: {
                optionConstraints: {
                  type: "object",
                  properties: {
                    size: { type: ["string", "null"] },
                    color: { type: ["string", "null"] },
                    material: { type: ["string", "null"] }
                  },
                  additionalProperties: false
                },
                priceCeiling: { type: ["number", "null"] },
                includeTerms: { type: "array", items: { type: "string" } },
                excludeTerms: { type: "array", items: { type: "string" } }
              },
              additionalProperties: false
            }
          },
          required: ["hardTerms", "quantity"],
          additionalProperties: false
        },
        description: "Array of bundle items (only populated if isBundle is true)"
      },
      totalBudget: {
        type: ["number", "null"],
        description: "Total budget for bundle if specified (e.g., 500 for '$500 budget')"
      },
      totalBudgetCurrency: {
        type: ["string", "null"],
        description: "Currency code if detected (e.g., 'USD', 'GBP', 'EUR')"
      },
      preferences: {
        type: "array",
        items: { type: "string" },
        description: "Style or preference terms that guide selection but aren't hard requirements (e.g., 'plain', 'wireless', 'organic', 'eco-friendly')"
      }
    },
    required: ["isBundle", "hardTerms", "softTerms", "avoidTerms", "hardFacets"],
    additionalProperties: false
  };
}

/**
 * Parse user intent using OpenAI LLM
 * Returns structured intent that replaces pattern-based parsing
 */
export async function parseIntentWithLLM(
  userQuery: string,
  conversationHistory?: Array<{ role: "system" | "user" | "assistant"; content: string }>
): Promise<IntentParseResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      success: false,
      error: "OPENAI_API_KEY not set",
      fallbackUsed: true
    };
  }

  const model = process.env.OPENAI_MODEL || DEFAULT_MODEL;

  // Build system prompt for intent understanding
  const systemPrompt = `You are an expert at understanding user shopping queries and extracting structured intent.

Your task is to analyze the user's query and extract:
1. **Hard Terms**: Concrete, searchable product terms and attributes (e.g., "blue", "shirt", "laptop", "sofa", "cotton", "wireless", "large")
2. **Soft Terms**: Abstract concepts, context, or style preferences (e.g., "formal", "casual", "work", "wedding", "eco-friendly")
3. **Avoid Terms**: Things the user wants to exclude (e.g., "no prints", "avoid plastic", "not red", "without batteries")
4. **Hard Facets**: Specific size, color, or material constraints if mentioned (works for any industry)
5. **Bundle Detection**: Whether the user wants multiple distinct items (e.g., "laptop and mouse", "sofa and table", "suit and shirt") vs a single item
6. **Preferences**: Style or feature preferences that guide selection (e.g., "plain", "wireless", "organic", "rechargeable", "waterproof")

**Critical Rules:**
1. **Product vs Preference**: "i want plain" = preference for plain style, NOT a product. "plain shirt" = product with "plain" attribute. "i want wireless" = preference, "wireless headphones" = product.
2. **Avoid Terms**: "no X", "avoid X", "not X", "without X" → extract X to avoidTerms (works for any industry)
3. **Bundle Detection**: Only true if user wants MULTIPLE DISTINCT products (e.g., "laptop and mouse", "sofa and chair", "suit and shirt"). Single item with preferences is NOT a bundle.
4. **Exact Terms**: Extract terms exactly as user wrote them - NO synonym expansion, NO assumptions, NO industry-specific knowledge
5. **Industry Agnostic**: Work for ANY industry (fashion, electronics, home goods, beauty, health, automotive, etc.) - do NOT hardcode categories or assume any specific industry
6. **Context Awareness**: Use conversation history to understand context (e.g., follow-up questions)

**Examples (diverse industries):**
- Fashion: "Blue shirt but no prints or floral, i want plain" → isBundle: false, hardTerms: ["blue", "shirt"], avoidTerms: ["prints", "floral"], preferences: ["plain"]
- Electronics: "Wireless headphones under $100" → isBundle: false, hardTerms: ["wireless", "headphones"], totalBudget: 100, preferences: ["wireless"]
- Home: "Sofa and coffee table" → isBundle: true, bundleItems: [{"hardTerms": ["sofa"]}, {"hardTerms": ["coffee", "table"]}]
- Beauty: "Organic face cream without parabens" → isBundle: false, hardTerms: ["organic", "face", "cream"], avoidTerms: ["parabens"], preferences: ["organic"]
- Fashion Bundle: "Suit, shirt and trousers for $500" → isBundle: true, bundleItems: [{"hardTerms": ["suit"]}, {"hardTerms": ["shirt"]}, {"hardTerms": ["trousers"]}], totalBudget: 500
- Electronics Bundle: "Laptop, mouse and keyboard" → isBundle: true, bundleItems: [{"hardTerms": ["laptop"]}, {"hardTerms": ["mouse"]}, {"hardTerms": ["keyboard"]}]`;

  // Build messages array
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
  
  if (conversationHistory && conversationHistory.length > 0) {
    // Use conversation context if available
    const hasSystemMessage = conversationHistory[0]?.role === "system";
    if (hasSystemMessage) {
      messages.push({
        role: "system",
        content: `${conversationHistory[0].content}\n\n${systemPrompt}`
      });
      messages.push(...conversationHistory.slice(1));
    } else {
      messages.push({ role: "system", content: systemPrompt });
      messages.push(...conversationHistory);
    }
  } else {
    messages.push({ role: "system", content: systemPrompt });
  }
  
  messages.push({
    role: "user",
    content: `Parse the intent from this query: "${userQuery}"`
  });

  // Build request body with strict JSON schema
  const requestBody = {
    model,
    messages,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "parsed_intent",
        strict: true,
        schema: buildIntentSchema()
      }
    },
    temperature: 0, // Deterministic output
    max_tokens: 500
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), INTENT_PARSE_TIMEOUT_MS);

    const response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      signal: controller.signal,
      body: JSON.stringify(requestBody)
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      console.warn("[Intent Parsing] OpenAI API error:", response.status, errorText.substring(0, 200));
      return {
        success: false,
        error: `HTTP ${response.status}`,
        fallbackUsed: true
      };
    }

    const data = await response.json();
    const message = data.choices?.[0]?.message;
    
    if (!message || !message.content) {
      return {
        success: false,
        error: "No message content in response",
        fallbackUsed: true
      };
    }

    // Parse JSON from message.content
    let parsedIntent: ParsedIntent;
    try {
      parsedIntent = JSON.parse(message.content);
    } catch (parseError) {
      console.warn("[Intent Parsing] JSON parse error:", parseError);
      return {
        success: false,
        error: "Failed to parse JSON response",
        fallbackUsed: true
      };
    }

    // Validate required fields
    if (!parsedIntent.hardTerms || !Array.isArray(parsedIntent.hardTerms)) {
      parsedIntent.hardTerms = [];
    }
    if (!parsedIntent.softTerms || !Array.isArray(parsedIntent.softTerms)) {
      parsedIntent.softTerms = [];
    }
    if (!parsedIntent.avoidTerms || !Array.isArray(parsedIntent.avoidTerms)) {
      parsedIntent.avoidTerms = [];
    }
    if (!parsedIntent.hardFacets) {
      parsedIntent.hardFacets = { size: null, color: null, material: null };
    }
    if (parsedIntent.isBundle && (!parsedIntent.bundleItems || !Array.isArray(parsedIntent.bundleItems))) {
      parsedIntent.bundleItems = [];
    }

    console.log("[Intent Parsing] ✅ LLM parsed intent:", {
      isBundle: parsedIntent.isBundle,
      hardTermsCount: parsedIntent.hardTerms.length,
      avoidTermsCount: parsedIntent.avoidTerms.length,
      preferencesCount: parsedIntent.preferences?.length || 0
    });

    return {
      success: true,
      intent: parsedIntent,
      fallbackUsed: false
    };

  } catch (error: any) {
    if (error.name === "AbortError") {
      console.warn("[Intent Parsing] Timeout after", INTENT_PARSE_TIMEOUT_MS, "ms");
      return {
        success: false,
        error: "Request timeout",
        fallbackUsed: true
      };
    }
    
    console.warn("[Intent Parsing] Error:", error.message || String(error));
    return {
      success: false,
      error: error.message || String(error),
      fallbackUsed: true
    };
  }
}

