/**
 * Cleans and formats AI-generated reasoning text to ensure it's always clean, clear, and well-formatted.
 * This function removes technical jargon, incomplete thoughts, and ensures proper formatting.
 */
export function cleanReasoning(text: string | null | undefined): string {
  if (!text || !text.trim()) return "";
  
  // Remove technical jargon and incomplete thoughts
  let cleaned = text.trim();
  
  // Remove common technical prefixes
  cleaned = cleaned.replace(/^(reasoning|explanation|selection|rationale|note|summary):\s*/i, "");
  
  // Remove markdown formatting if present
  cleaned = cleaned.replace(/\*\*(.*?)\*\*/g, "$1");
  cleaned = cleaned.replace(/\*(.*?)\*/g, "$1");
  cleaned = cleaned.replace(/`(.*?)`/g, "$1");
  cleaned = cleaned.replace(/\[(.*?)\]\(.*?\)/g, "$1"); // Remove markdown links
  
  // Remove incomplete sentences (ending with incomplete words or fragments)
  cleaned = cleaned.replace(/\s+[a-z]{1,3}\s*$/i, "");
  
  // Remove sentence fragments that don't make sense
  cleaned = cleaned.replace(/\b(handle|score|label|itemIndex|productId|id):\s*\w+/gi, "");
  
  // Remove JSON-like structures
  cleaned = cleaned.replace(/\{[^}]*\}/g, "");
  cleaned = cleaned.replace(/\[[^\]]*\]/g, "");
  
  // Remove excessive punctuation
  cleaned = cleaned.replace(/[!]{2,}/g, "!");
  cleaned = cleaned.replace(/[?]{2,}/g, "?");
  cleaned = cleaned.replace(/[.]{3,}/g, "...");
  
  // Ensure it starts with a capital letter
  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }
  
  // Ensure it ends with proper punctuation
  if (cleaned.length > 0 && !/[.!?]$/.test(cleaned)) {
    cleaned += ".";
  }
  
  // Remove excessive whitespace
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  
  // Remove redundant phrases that make reasoning sound robotic
  cleaned = cleaned.replace(/\b(based on|according to|due to|because of)\s+(the\s+)?(user|shopper|customer|your)\s+(intent|query|request|preferences|needs|requirements)\s*,?\s*/gi, "");
  cleaned = cleaned.replace(/\b(these\s+)?(products?|items?|selections?)\s+(were|are|is)\s+(selected|chosen|picked)\s+(because|due to|based on)\s*/gi, "");
  cleaned = cleaned.replace(/\b(selected|chosen|picked)\s+(these\s+)?(products?|items?)\s+(because|due to|based on)\s*/gi, "");
  cleaned = cleaned.replace(/\b(i|we|the system|the ai|the model)\s+(selected|chose|picked|determined|decided)\s+/gi, "");
  
  // Remove technical terms that customers don't need to see
  cleaned = cleaned.replace(/\b(handle|productId|itemIndex|score|label|exact|good|fallback|trustFallback|candidate|ranking|algorithm|model|ai|llm)\b/gi, "");
  
  // Clean up any remaining fragments
  cleaned = cleaned.replace(/^[,\s\-]+|[,\s\-]+$/g, "");
  cleaned = cleaned.replace(/\s*,\s*,/g, ","); // Remove double commas
  cleaned = cleaned.replace(/\s*\.\s*\./g, "."); // Remove double periods
  
  // Ensure sentences are properly separated
  cleaned = cleaned.replace(/\s+([A-Z])/g, ". $1"); // Add period before capital letters (new sentences)
  
  // Final trim and validation
  cleaned = cleaned.trim();
  
  // If the cleaned text is too short or doesn't make sense, return empty
  if (cleaned.length < 10) {
    return "";
  }
  
  // Ensure it's a complete thought (has at least one verb or meaningful content)
  const hasVerb = /\b(is|are|were|was|have|has|had|do|does|did|can|could|will|would|should|match|matches|selected|chosen|picked|recommended|suitable|perfect|ideal|best|great|excellent|good|quality|features?|benefits?|attributes?|characteristics?|properties?)\b/i.test(cleaned);
  if (!hasVerb && cleaned.length < 30) {
    return "";
  }
  
  return cleaned;
}

/**
 * Combines multiple reasoning strings into a single, coherent explanation
 */
export function combineReasonings(reasonings: string[]): string {
  const cleaned = reasonings
    .map(r => cleanReasoning(r))
    .filter(Boolean);
  
  if (cleaned.length === 0) {
    return "";
  }
  
  if (cleaned.length === 1) {
    return cleaned[0];
  }
  
  // Remove duplicates
  const unique = Array.from(new Set(cleaned));
  
  if (unique.length === 1) {
    return unique[0];
  }
  
  // If we have 2-3 unique reasons, combine them naturally
  if (unique.length <= 3) {
    // Join with appropriate connectors
    if (unique.length === 2) {
      return `${unique[0]} Additionally, ${unique[1].toLowerCase()}`;
    } else {
      return `${unique[0]} ${unique[1]} Finally, ${unique[2].toLowerCase()}`;
    }
  }
  
  // Too many different reasons - create a summary from the first few
  return `${unique[0]} These products were carefully selected based on your specific requirements and preferences.`;
}

