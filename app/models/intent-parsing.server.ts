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
const INTENT_PARSE_TIMEOUT_BASE_MS = 20000; // Base 20 seconds for intent parsing
const INTENT_PARSE_TIMEOUT_MAX_MS = 30000; // Cap at 30 seconds
const INTENT_PARSE_RETRY_BACKOFF_MIN_MS = 300; // Minimum backoff for retry
const INTENT_PARSE_RETRY_BACKOFF_MAX_MS = 800; // Maximum backoff for retry

/**
 * Calculate dynamic timeout based on conversation length
 */
function calculateIntentParseTimeout(conversationHistory?: Array<{ role: string; content: string }>): number {
  let timeoutMs = INTENT_PARSE_TIMEOUT_BASE_MS;
  
  if (conversationHistory && conversationHistory.length > 3) {
    // Add 5s per message beyond 3 messages
    const extraMessages = conversationHistory.length - 3;
    timeoutMs += extraMessages * 5000;
  }
  
  // Cap at maximum
  return Math.min(timeoutMs, INTENT_PARSE_TIMEOUT_MAX_MS);
}

/**
 * Check if an error is a timeout/abort error
 */
function isTimeoutError(error: any): boolean {
  return error?.name === "AbortError" || 
         error?.message?.toLowerCase().includes("timeout") ||
         error?.message?.toLowerCase().includes("aborted") ||
         error?.code === "ECONNABORTED";
}

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
              type: "integer",
              minimum: 1,
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
                  required: ["size", "color", "material"],
                  additionalProperties: false
                },
                priceCeiling: { type: ["number", "null"] },
                includeTerms: { type: "array", items: { type: "string" } },
                excludeTerms: { type: "array", items: { type: "string" } }
              },
              required: ["optionConstraints", "priceCeiling", "includeTerms", "excludeTerms"],
              additionalProperties: false
            }
          },
          required: ["hardTerms", "quantity", "constraints"],
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
    required: ["isBundle", "hardTerms", "softTerms", "avoidTerms", "hardFacets", "bundleItems", "totalBudget", "totalBudgetCurrency", "preferences"],
    additionalProperties: false
  };
}

/**
 * Single attempt at parsing intent with OpenAI LLM
 */
async function parseIntentAttempt(
  userQuery: string,
  conversationHistory: Array<{ role: "system" | "user" | "assistant"; content: string }> | undefined,
  timeoutMs: number
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
  const systemPrompt = `You are an expert at understanding user shopping queries and extracting structured intent. You work for ANY industry (fashion, electronics, home goods, beauty, health, automotive, food, sports, etc.).

Your task is to analyze the user's query and extract:
1. **Hard Terms**: Concrete, searchable product terms and attributes (e.g., "blue", "shirt", "laptop", "sofa", "cotton", "wireless", "large", "organic", "rechargeable")
2. **Soft Terms**: Abstract concepts, context, or style preferences (e.g., "formal", "casual", "work", "wedding", "eco-friendly", "comfortable", "stylish")
3. **Avoid Terms**: Things the user wants to exclude (e.g., "no prints", "avoid plastic", "not red", "without batteries", "no floral", "don't want X")
4. **Hard Facets**: Specific size, color, or material constraints if mentioned (works for any industry)
   - **CRITICAL**: Explicit sizes/colors/materials MUST be assigned to hardFacets (and per-item optionConstraints in bundle mode), NOT left in hardTerms
   - If user says "in large" after listing multiple items, treat it as a global size unless an item-specific size is clearly stated
   - Example: "suit, shirt and trousers in large" → hardFacets: {size: "large", color: null, material: null}, bundleItems with size applied globally
   - Example: "blue shirt in medium, black trousers in large" → per-item optionConstraints: shirt {size: "medium", color: "blue"}, trousers {size: "large", color: "black"}
5. **Bundle Detection**: Whether the user wants MULTIPLE DISTINCT products (e.g., "laptop and mouse", "sofa and table", "suit and shirt") vs a single item
6. **Preferences**: Style or feature preferences that guide selection (e.g., "plain", "wireless", "organic", "rechargeable", "waterproof", "eco-friendly")

**CRITICAL RULES (MUST FOLLOW):**
1. **Product vs Preference**: 
   - "i want plain" = preference ["plain"], NOT a product
   - "plain shirt" = product with hardTerms ["plain", "shirt"]
   - "i want wireless" = preference ["wireless"]
   - "wireless headphones" = product with hardTerms ["wireless", "headphones"]
   - "i want it plain" = preference ["plain"], NOT a product
   - "i need organic" = preference ["organic"]
   - "organic face cream" = product with hardTerms ["organic", "face", "cream"]

2. **Avoid Terms Extraction**:
   - "no X", "avoid X", "not X", "without X", "don't want X", "exclude X" → extract X to avoidTerms
   - "no prints or floral" → avoidTerms: ["prints", "floral"]
   - "not red" → avoidTerms: ["red"]
   - "without parabens" → avoidTerms: ["parabens"]
   - Works for ANY industry

3. **Bundle Detection (STRICT)**:
   - ONLY true if user wants MULTIPLE DISTINCT products
   - "laptop and mouse" → isBundle: true (2 products)
   - "sofa and chair" → isBundle: true (2 products)
   - "suit, shirt and trousers" → isBundle: true (3 products)
   - "blue shirt, no prints, i want plain" → isBundle: false (single item with preferences/constraints)
   - "i want a blue shirt, no floral or print, i want it plain" → isBundle: false (single item)
   - "outfit" or "set" alone → isBundle: false (abstract collection term, not multiple distinct items)
   - Single item with multiple preferences/constraints is NOT a bundle

4. **Exact Terms**: Extract terms exactly as user wrote them - NO synonym expansion, NO assumptions, NO industry-specific knowledge

5. **Industry Agnostic**: Work for ANY industry - do NOT hardcode categories or assume any specific industry

6. **Context Awareness**: Use conversation history to understand context (e.g., follow-up questions)

**EXAMPLES (diverse industries and query types):**
- Fashion Single: "Blue shirt but no prints or floral, i want plain" → isBundle: false, hardTerms: ["blue", "shirt"], avoidTerms: ["prints", "floral"], preferences: ["plain"]
- Fashion Single: "i want a blue shirt, no floral or print, i want it plain" → isBundle: false, hardTerms: ["blue", "shirt"], avoidTerms: ["floral", "print"], preferences: ["plain"]
- Electronics Single: "Wireless headphones under $100" → isBundle: false, hardTerms: ["wireless", "headphones"], totalBudget: 100, preferences: ["wireless"]
- Electronics Single: "I need a laptop for work" → isBundle: false, hardTerms: ["laptop"], softTerms: ["work"]
- Home Single: "Comfortable sofa in gray" → isBundle: false, hardTerms: ["sofa"], softTerms: ["comfortable"], hardFacets: {color: "gray", size: null, material: null}
- Home Bundle: "Sofa and coffee table" → isBundle: true, bundleItems: [{"hardTerms": ["sofa"]}, {"hardTerms": ["coffee", "table"]}]
- Beauty Single: "Organic face cream without parabens" → isBundle: false, hardTerms: ["organic", "face", "cream"], avoidTerms: ["parabens"], preferences: ["organic"]
- Fashion Bundle: "Suit, shirt and trousers for $500" → isBundle: true, bundleItems: [{"hardTerms": ["suit"]}, {"hardTerms": ["shirt"]}, {"hardTerms": ["trousers"]}], totalBudget: 500
- Electronics Bundle: "Laptop, mouse and keyboard" → isBundle: true, bundleItems: [{"hardTerms": ["laptop"]}, {"hardTerms": ["mouse"]}, {"hardTerms": ["keyboard"]}]
- Health Bundle: "Protein powder and shaker bottle" → isBundle: true, bundleItems: [{"hardTerms": ["protein", "powder"]}, {"hardTerms": ["shaker", "bottle"]}]
- Sports Bundle: "Running shoes and workout clothes" → isBundle: true, bundleItems: [{"hardTerms": ["running", "shoes"]}, {"hardTerms": ["workout", "clothes"]}]
- Food Single: "Organic coffee beans" → isBundle: false, hardTerms: ["organic", "coffee", "beans"], preferences: ["organic"]
- Automotive Single: "Car phone mount" → isBundle: false, hardTerms: ["car", "phone", "mount"]

**OUTPUT REQUIREMENTS:**
- Always return valid JSON matching the schema exactly
- All arrays must be arrays (even if empty)
- All objects must have required fields (can be null)
- Bundle items only populated if isBundle is true
- Preferences array can be empty if none detected`;

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
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

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
    
    // Try to use parsed output first (if available from structured outputs)
    let parsedIntent: ParsedIntent;
    if (message?.parsed) {
      // Use parsed output directly (structured outputs with strict schema)
      parsedIntent = message.parsed as ParsedIntent;
      console.log("[Intent Parsing] structured_outputs=true (using parsed output)");
    } else if (message?.content) {
      // Fallback to parsing JSON from content
      try {
        parsedIntent = JSON.parse(message.content);
        console.log("[Intent Parsing] structured_outputs=true (parsed from content)");
      } catch (parseError) {
        console.warn("[Intent Parsing] JSON parse error:", parseError);
        return {
          success: false,
          error: "Failed to parse JSON response",
          fallbackUsed: true
        };
      }
    } else {
      return {
        success: false,
        error: "No message content or parsed output in response",
        fallbackUsed: true
      };
    }

    // Validate and normalize required fields
    if (!parsedIntent.hardTerms || !Array.isArray(parsedIntent.hardTerms)) {
      parsedIntent.hardTerms = [];
    }
    if (!parsedIntent.softTerms || !Array.isArray(parsedIntent.softTerms)) {
      parsedIntent.softTerms = [];
    }
    if (!parsedIntent.avoidTerms || !Array.isArray(parsedIntent.avoidTerms)) {
      parsedIntent.avoidTerms = [];
    }
    if (!parsedIntent.hardFacets || typeof parsedIntent.hardFacets !== "object") {
      parsedIntent.hardFacets = { size: null, color: null, material: null };
    } else {
      // Ensure all required fields exist
      if (typeof parsedIntent.hardFacets.size !== "string" && parsedIntent.hardFacets.size !== null) {
        parsedIntent.hardFacets.size = null;
      }
      if (typeof parsedIntent.hardFacets.color !== "string" && parsedIntent.hardFacets.color !== null) {
        parsedIntent.hardFacets.color = null;
      }
      if (typeof parsedIntent.hardFacets.material !== "string" && parsedIntent.hardFacets.material !== null) {
        parsedIntent.hardFacets.material = null;
      }
    }
    
    // Validate bundle structure
    if (parsedIntent.isBundle === true) {
      if (!parsedIntent.bundleItems || !Array.isArray(parsedIntent.bundleItems)) {
        parsedIntent.bundleItems = [];
      }
      // Validate each bundle item
      parsedIntent.bundleItems = parsedIntent.bundleItems
        .filter(item => item && typeof item === "object")
        .map(item => ({
          hardTerms: Array.isArray(item.hardTerms) ? item.hardTerms.filter(t => typeof t === "string") : [],
          quantity: typeof item.quantity === "number" && item.quantity > 0 ? item.quantity : 1,
          constraints: item.constraints && typeof item.constraints === "object" ? {
            optionConstraints: item.constraints.optionConstraints && typeof item.constraints.optionConstraints === "object" ? {
              size: typeof item.constraints.optionConstraints.size === "string" ? item.constraints.optionConstraints.size : null,
              color: typeof item.constraints.optionConstraints.color === "string" ? item.constraints.optionConstraints.color : null,
              material: typeof item.constraints.optionConstraints.material === "string" ? item.constraints.optionConstraints.material : null
            } : undefined,
            priceCeiling: typeof item.constraints.priceCeiling === "number" ? item.constraints.priceCeiling : null,
            includeTerms: Array.isArray(item.constraints.includeTerms) ? item.constraints.includeTerms.filter(t => typeof t === "string") : undefined,
            excludeTerms: Array.isArray(item.constraints.excludeTerms) ? item.constraints.excludeTerms.filter(t => typeof t === "string") : undefined
          } : undefined
        }))
        .filter(item => item.hardTerms.length > 0); // Remove items with no hard terms
      
      // If bundle has less than 2 valid items, it's not a bundle
      if (parsedIntent.bundleItems.length < 2) {
        parsedIntent.isBundle = false;
        parsedIntent.bundleItems = [];
      }
    } else {
      parsedIntent.bundleItems = [];
    }
    
    // Validate preferences
    if (!parsedIntent.preferences || !Array.isArray(parsedIntent.preferences)) {
      parsedIntent.preferences = [];
    }
    
    // Validate budget
    if (parsedIntent.totalBudget !== null && (typeof parsedIntent.totalBudget !== "number" || parsedIntent.totalBudget <= 0)) {
      parsedIntent.totalBudget = null;
    }
    if (parsedIntent.totalBudgetCurrency !== null && typeof parsedIntent.totalBudgetCurrency !== "string") {
      parsedIntent.totalBudgetCurrency = null;
    }
    
    // Normalize string arrays (remove empty strings, trim)
    parsedIntent.hardTerms = parsedIntent.hardTerms.filter(t => typeof t === "string" && t.trim().length > 0).map(t => t.trim());
    parsedIntent.softTerms = parsedIntent.softTerms.filter(t => typeof t === "string" && t.trim().length > 0).map(t => t.trim());
    parsedIntent.avoidTerms = parsedIntent.avoidTerms.filter(t => typeof t === "string" && t.trim().length > 0).map(t => t.trim());
    parsedIntent.preferences = parsedIntent.preferences.filter(t => typeof t === "string" && t.trim().length > 0).map(t => t.trim());

    console.log("[Intent Parsing] ✅ LLM parsed intent:", {
      isBundle: parsedIntent.isBundle,
      hardTermsCount: parsedIntent.hardTerms.length,
      softTermsCount: parsedIntent.softTerms.length,
      avoidTermsCount: parsedIntent.avoidTerms.length,
      preferencesCount: parsedIntent.preferences.length,
      bundleItemsCount: parsedIntent.bundleItems?.length || 0,
      totalBudget: parsedIntent.totalBudget
    });

    return {
      success: true,
      intent: parsedIntent,
      fallbackUsed: false
    };

  } catch (error: any) {
    if (isTimeoutError(error)) {
      console.warn("[Intent Parsing] Timeout after", timeoutMs, "ms");
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

/**
 * Parse user intent using OpenAI LLM with retry on timeout
 * Returns structured intent that replaces pattern-based parsing
 */
export async function parseIntentWithLLM(
  userQuery: string,
  conversationHistory?: Array<{ role: "system" | "user" | "assistant"; content: string }>
): Promise<IntentParseResult> {
  // Calculate dynamic timeout
  const timeoutMs = calculateIntentParseTimeout(conversationHistory);
  
  // First attempt
  let result = await parseIntentAttempt(userQuery, conversationHistory, timeoutMs);
  
  // Retry only on timeout errors
  if (!result.success && result.error === "Request timeout") {
    // Small jitter backoff (300-800ms)
    const backoffMs = INTENT_PARSE_RETRY_BACKOFF_MIN_MS + 
      Math.floor(Math.random() * (INTENT_PARSE_RETRY_BACKOFF_MAX_MS - INTENT_PARSE_RETRY_BACKOFF_MIN_MS));
    
    console.log(`[Intent Parsing] Retrying after timeout, backoff=${backoffMs}ms`);
    await new Promise(resolve => setTimeout(resolve, backoffMs));
    
    // Second attempt
    result = await parseIntentAttempt(userQuery, conversationHistory, timeoutMs);
    
    if (!result.success) {
      // Both attempts failed - mark clearly in logs
      console.warn(`[Intent Parsing] fallback=pattern timeout=true attempts=2`);
    }
  }
  
  return result;
}

