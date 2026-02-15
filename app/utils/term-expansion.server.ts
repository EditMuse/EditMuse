/**
 * Industry-agnostic Term Expansion Pipeline
 * Expands search terms using morphology, spelling variants, abbreviations, and LLM synonyms
 */

import prisma from "~/db.server";

/**
 * Multi-lingual term mappings (industry-agnostic)
 * Common product terms in multiple languages: Spanish, French, German, Italian, Portuguese
 */
const MULTILINGUAL_MAP: Record<string, string[]> = {
  // English -> Spanish
  "perfume": ["perfume", "fragancia"],
  "fragrance": ["fragancia", "perfume"],
  "shoes": ["zapatos", "calzado"],
  "shirt": ["camisa"],
  "dress": ["vestido"],
  "pants": ["pantalones"],
  "jacket": ["chaqueta", "saco"],
  "bag": ["bolsa", "bolso", "mochila"],
  "watch": ["reloj"],
  "phone": ["teléfono", "celular"],
  "laptop": ["portátil", "laptop"],
  "headphones": ["auriculares", "audífonos"],
  "sofa": ["sofá"],
  "table": ["mesa"],
  "chair": ["silla"],
  "bed": ["cama"],
  "lamp": ["lámpara"],
  "car": ["coche", "carro", "auto"],
  "bike": ["bicicleta", "bici"],
  "gift": ["regalo"],
  "sale": ["oferta", "rebaja", "descuento"],
  
  // English -> French
  "shoes": ["chaussures"],
  "shirt": ["chemise"],
  "dress": ["robe"],
  "pants": ["pantalon"],
  "jacket": ["veste", "blouson"],
  "bag": ["sac", "sac à main"],
  "watch": ["montre"],
  "phone": ["téléphone", "portable"],
  "laptop": ["ordinateur portable", "laptop"],
  "headphones": ["écouteurs", "casque"],
  "sofa": ["canapé", "sofa"],
  "table": ["table"],
  "chair": ["chaise"],
  "bed": ["lit"],
  "lamp": ["lampe"],
  "car": ["voiture", "auto"],
  "bike": ["vélo", "bicyclette"],
  "gift": ["cadeau"],
  "sale": ["solde", "promotion"],
  
  // English -> German
  "perfume": ["parfüm"],
  "shoes": ["schuhe"],
  "shirt": ["hemd"],
  "dress": ["kleid"],
  "pants": ["hose"],
  "jacket": ["jacke", "mantel"],
  "bag": ["tasche", "beutel"],
  "watch": ["uhr", "armbanduhr"],
  "phone": ["telefon", "handy"],
  "laptop": ["laptop", "notebook"],
  "headphones": ["kopfhörer"],
  "sofa": ["sofa", "couch"],
  "table": ["tisch"],
  "chair": ["stuhl"],
  "bed": ["bett"],
  "lamp": ["lampe"],
  "car": ["auto", "wagen"],
  "bike": ["fahrrad", "rad"],
  "gift": ["geschenk"],
  "sale": ["angebot", "rabatt"],
  
  // English -> Italian
  "perfume": ["profumo"],
  "shoes": ["scarpe"],
  "shirt": ["camicia"],
  "dress": ["vestito", "abito"],
  "pants": ["pantaloni"],
  "jacket": ["giacca"],
  "bag": ["borsa", "zaino"],
  "watch": ["orologio"],
  "phone": ["telefono", "cellulare"],
  "laptop": ["laptop", "portatile"],
  "headphones": ["cuffie", "auricolari"],
  "sofa": ["divano", "sofà"],
  "table": ["tavolo"],
  "chair": ["sedia"],
  "bed": ["letto"],
  "lamp": ["lampada"],
  "car": ["auto", "macchina"],
  "bike": ["bicicletta", "bici"],
  "gift": ["regalo"],
  "sale": ["sconto", "offerta"],
  
  // English -> Portuguese
  "perfume": ["perfume"],
  "shoes": ["sapatos", "calçados"],
  "shirt": ["camisa"],
  "dress": ["vestido"],
  "pants": ["calças"],
  "jacket": ["jaqueta", "casaco"],
  "bag": ["bolsa", "mochila"],
  "watch": ["relógio"],
  "phone": ["telefone", "celular"],
  "laptop": ["laptop", "notebook"],
  "headphones": ["fones de ouvido"],
  "sofa": ["sofá"],
  "table": ["mesa"],
  "chair": ["cadeira"],
  "bed": ["cama"],
  "lamp": ["lâmpada"],
  "car": ["carro", "automóvel"],
  "bike": ["bicicleta"],
  "gift": ["presente"],
  "sale": ["promoção", "desconto"],
  
  // Reverse mappings (Spanish -> English, etc.)
  "zapatos": ["shoes"],
  "camisa": ["shirt"],
  "vestido": ["dress"],
  "pantalones": ["pants"],
  "chaqueta": ["jacket"],
  "bolsa": ["bag"],
  "reloj": ["watch"],
  "teléfono": ["phone"],
  "celular": ["phone"],
  "sofá": ["sofa"],
  "mesa": ["table"],
  "silla": ["chair"],
  "cama": ["bed"],
  "lámpara": ["lamp"],
  "coche": ["car"],
  "bicicleta": ["bike"],
  "regalo": ["gift"],
  "oferta": ["sale"],
  
  "chaussures": ["shoes"],
  "chemise": ["shirt"],
  "robe": ["dress"],
  "pantalon": ["pants"],
  "veste": ["jacket"],
  "sac": ["bag"],
  "montre": ["watch"],
  "téléphone": ["phone"],
  "canapé": ["sofa"],
  "chaise": ["chair"],
  "lit": ["bed"],
  "lampe": ["lamp"],
  "voiture": ["car"],
  "vélo": ["bike"],
  "cadeau": ["gift"],
  "solde": ["sale"],
  
  "schuhe": ["shoes"],
  "hemd": ["shirt"],
  "kleid": ["dress"],
  "hose": ["pants"],
  "jacke": ["jacket"],
  "tasche": ["bag"],
  "uhr": ["watch"],
  "telefon": ["phone"],
  "sofa": ["sofa"],
  "tisch": ["table"],
  "stuhl": ["chair"],
  "bett": ["bed"],
  "lampe": ["lamp"],
  "auto": ["car"],
  "fahrrad": ["bike"],
  "geschenk": ["gift"],
  "angebot": ["sale"],
  
  "scarpe": ["shoes"],
  "camicia": ["shirt"],
  "vestito": ["dress"],
  "pantaloni": ["pants"],
  "giacca": ["jacket"],
  "borsa": ["bag"],
  "orologio": ["watch"],
  "telefono": ["phone"],
  "divano": ["sofa"],
  "tavolo": ["table"],
  "sedia": ["chair"],
  "letto": ["bed"],
  "lampada": ["lamp"],
  "auto": ["car"],
  "bicicletta": ["bike"],
  "regalo": ["gift"],
  "sconto": ["sale"],
  
  "sapatos": ["shoes"],
  "camisa": ["shirt"],
  "vestido": ["dress"],
  "calças": ["pants"],
  "jaqueta": ["jacket"],
  "bolsa": ["bag"],
  "relógio": ["watch"],
  "telefone": ["phone"],
  "sofá": ["sofa"],
  "mesa": ["table"],
  "cadeira": ["chair"],
  "cama": ["bed"],
  "lâmpada": ["lamp"],
  "carro": ["car"],
  "bicicleta": ["bike"],
  "presente": ["gift"],
  "promoção": ["sale"],
  
  // English -> Dutch
  "shoes": ["schoenen"],
  "shirt": ["shirt", "overhemd"],
  "dress": ["jurk"],
  "pants": ["broek"],
  "jacket": ["jas"],
  "bag": ["tas"],
  "watch": ["horloge"],
  "phone": ["telefoon"],
  "sofa": ["bank", "sofa"],
  "table": ["tafel"],
  "chair": ["stoel"],
  "bed": ["bed"],
  "car": ["auto"],
  "gift": ["cadeau"],
  "sale": ["uitverkoop", "korting"],
  
  // English -> Russian (transliterated)
  "shoes": ["обувь", "туфли"],
  "shirt": ["рубашка"],
  "dress": ["платье"],
  "pants": ["брюки"],
  "jacket": ["куртка"],
  "bag": ["сумка"],
  "watch": ["часы"],
  "phone": ["телефон"],
  "sofa": ["диван"],
  "table": ["стол"],
  "chair": ["стул"],
  "bed": ["кровать"],
  "car": ["машина", "автомобиль"],
  "gift": ["подарок"],
  "sale": ["распродажа", "скидка"],
  
  // English -> Japanese (transliterated)
  "shoes": ["靴", "シューズ"],
  "shirt": ["シャツ"],
  "dress": ["ドレス"],
  "pants": ["パンツ"],
  "jacket": ["ジャケット"],
  "bag": ["バッグ"],
  "watch": ["時計", "ウォッチ"],
  "phone": ["電話", "スマホ"],
  "sofa": ["ソファ"],
  "table": ["テーブル"],
  "chair": ["椅子", "チェア"],
  "bed": ["ベッド"],
  "car": ["車", "カー"],
  "gift": ["贈り物", "ギフト"],
  "sale": ["セール", "割引"],
  
  // English -> Chinese (transliterated)
  "shoes": ["鞋子", "鞋"],
  "shirt": ["衬衫"],
  "dress": ["连衣裙"],
  "pants": ["裤子"],
  "jacket": ["夹克"],
  "bag": ["包", "袋子"],
  "watch": ["手表"],
  "phone": ["手机", "电话"],
  "sofa": ["沙发"],
  "table": ["桌子"],
  "chair": ["椅子"],
  "bed": ["床"],
  "car": ["汽车", "车"],
  "gift": ["礼物"],
  "sale": ["促销", "折扣"],
  
  // Reverse mappings for additional languages
  "schoenen": ["shoes"],
  "jurk": ["dress"],
  "broek": ["pants"],
  "jas": ["jacket"],
  "tas": ["bag"],
  "horloge": ["watch"],
  "telefoon": ["phone"],
  "bank": ["sofa"],
  "tafel": ["table"],
  "stoel": ["chair"],
  "cadeau": ["gift"],
  "uitverkoop": ["sale"],
};

/**
 * UK/US/French spelling variant mappings (industry-agnostic)
 * Includes common regional spelling differences across all industries
 */
const LOCALE_VARIANTS: Record<string, string[]> = {
  // UK -> US
  "colour": ["color"],
  "colours": ["colors"],
  "tyre": ["tire"],
  "tyres": ["tires"],
  "moisturiser": ["moisturizer"],
  "moisturisers": ["moisturizers"],
  "moisturise": ["moisturize"],
  "centre": ["center"],
  "centres": ["centers"],
  "organise": ["organize"],
  "organised": ["organized"],
  "favour": ["favor"],
  "favourites": ["favorites"],
  "realise": ["realize"],
  "realised": ["realized"],
  "recognise": ["recognize"],
  "recognised": ["recognized"],
  // US -> UK (bidirectional)
  "color": ["colour"],
  "colors": ["colours"],
  "tire": ["tyre"],
  "tires": ["tyres"],
  "moisturizer": ["moisturiser"],
  "moisturizers": ["moisturisers"],
  "moisturize": ["moisturise"],
  "center": ["centre"],
  "centers": ["centres"],
  "organize": ["organise"],
  "organized": ["organised"],
  "favor": ["favour"],
  "favorites": ["favourites"],
  "realize": ["realise"],
  "realized": ["realised"],
  "recognize": ["recognise"],
  "recognized": ["recognised"],
  // French/English perfume variants (common in perfume industry)
  "perfume": ["parfume", "parfum"],
  "perfumes": ["parfumes", "parfums"],
  "parfume": ["perfume"],
  "parfumes": ["perfumes"],
  "parfum": ["perfume", "perfumes"],
  "parfums": ["perfumes"],
};

/**
 * Industry-agnostic synonym mappings
 * Common terms that are used interchangeably across industries
 */
const SYNONYM_MAP: Record<string, string[]> = {
  // Fashion/Apparel
  "sneakers": ["trainers", "runners", "athletic shoes", "sneaks", "kicks", "gym shoes"],
  "trainers": ["sneakers", "runners", "athletic shoes", "sneaks", "kicks"],
  "trousers": ["pants", "slacks"],
  "pants": ["trousers", "slacks"],
  "sweater": ["jumper", "pullover"],
  "jumper": ["sweater", "pullover"],
  "vest": ["waistcoat"],
  "waistcoat": ["vest"],
  "pajamas": ["pyjamas"],
  "pyjamas": ["pajamas"],
  "shorts": ["britches"], // Regional
  
  // Beauty/Cosmetics
  "makeup": ["make-up", "cosmetics"],
  "make-up": ["makeup", "cosmetics"],
  "lipstick": ["lip stick"],
  "mascara": ["mascara"], // Keep as-is
  "foundation": ["base", "base makeup"],
  "concealer": ["cover-up", "cover up"],
  "nail polish": ["nail varnish", "nail lacquer"],
  "nail varnish": ["nail polish", "nail lacquer"],
  
  // Electronics
  "phone": ["mobile", "cell phone", "cellular", "smartphone"],
  "mobile": ["phone", "cell phone", "cellular", "smartphone"],
  "cell phone": ["phone", "mobile", "cellular", "smartphone"],
  "laptop": ["notebook", "notebook computer"],
  "notebook": ["laptop"],
  "headphones": ["earphones", "earbuds", "ear buds", "headset"],
  "earphones": ["headphones", "earbuds", "ear buds"],
  "earbuds": ["earphones", "headphones", "ear buds"],
  "charger": ["charging cable", "power adapter", "power supply"],
  "charging cable": ["charger", "power cable"],
  "tv": ["television", "telly"],
  "television": ["tv", "telly"],
  
  // Home/Furniture
  "sofa": ["couch", "divan", "settee"],
  "couch": ["sofa", "divan", "settee"],
  "cushion": ["pillow"],
  "pillow": ["cushion"],
  "curtains": ["drapes", "window treatments"],
  "drapes": ["curtains", "window treatments"],
  "wardrobe": ["closet", "armoire"],
  "closet": ["wardrobe", "armoire"],
  "faucet": ["tap"],
  "tap": ["faucet"],
  
  // Food/Beverages
  "cookie": ["biscuit"],
  "biscuit": ["cookie"],
  "chips": ["crisps", "fries"], // Context-dependent but common
  "crisps": ["chips"],
  "soda": ["pop", "soft drink", "fizzy drink"],
  "pop": ["soda", "soft drink"],
  "candy": ["sweets", "confectionery"],
  "sweets": ["candy", "confectionery"],
  "zucchini": ["courgette"],
  "courgette": ["zucchini"],
  "eggplant": ["aubergine"],
  "aubergine": ["eggplant"],
  
  // Automotive
  "car": ["automobile", "vehicle", "auto"],
  "automobile": ["car", "vehicle", "auto"],
  "trunk": ["boot"],
  "boot": ["trunk"],
  "hood": ["bonnet"],
  "bonnet": ["hood"],
  "windshield": ["windscreen"],
  "windscreen": ["windshield"],
  
  // Sports
  "soccer": ["football"],
  "football": ["soccer", "american football"], // Context-dependent
  "cleats": ["boots", "football boots"],
  "jersey": ["shirt", "kit", "uniform"],
  "racket": ["racquet"],
  "racquet": ["racket"],
  "gym": ["fitness", "workout", "exercise"],
  "workout": ["exercise", "fitness", "gym"],
  
  // Pet Supplies
  "dog food": ["dog food", "puppy food", "canine food"],
  "cat food": ["cat food", "kitten food", "feline food"],
  "leash": ["lead", "lead rope"],
  "lead": ["leash"],
  "collar": ["dog collar", "pet collar"],
  "litter": ["cat litter", "kitty litter"],
  
  // Health/Wellness
  "vitamin": ["vitamins", "supplement", "supplements"],
  "supplement": ["vitamin", "vitamins"],
  "protein": ["protein powder", "protein shake"],
  "yoga mat": ["yoga mat", "exercise mat", "fitness mat"],
  "resistance band": ["resistance band", "exercise band", "fitness band"],
  
  // Office Supplies
  "stapler": ["stapler", "staple gun"],
  "paper clip": ["paper clip", "clip"],
  "binder": ["binder", "folder", "file folder"],
  "folder": ["binder", "file folder"],
  "notebook": ["notebook", "notepad", "pad"],
  "notepad": ["notebook", "pad"],
  
  // Gardening/Outdoor
  "plant pot": ["pot", "planter", "flower pot"],
  "planter": ["pot", "plant pot", "flower pot"],
  "garden": ["garden", "yard", "backyard"],
  "yard": ["garden", "backyard"],
  "shovel": ["spade", "digging tool"],
  "spade": ["shovel"],
  
  // Travel/Luggage
  "suitcase": ["luggage", "bag", "travel bag"],
  "luggage": ["suitcase", "bag", "travel bag"],
  "backpack": ["rucksack", "pack"],
  "rucksack": ["backpack", "pack"],
  "passport holder": ["passport case", "passport cover"],
  
  // Jewelry/Watches
  "watch": ["timepiece", "wristwatch"],
  "timepiece": ["watch", "wristwatch"],
  "necklace": ["necklace", "pendant"],
  "bracelet": ["bracelet", "bangle"],
  "earrings": ["earrings", "ear studs"],
  
  // Materials/Fabrics
  "cotton": ["cotton", "100% cotton"],
  "wool": ["wool", "woolen"],
  "leather": ["leather", "genuine leather"],
  "synthetic": ["synthetic", "man-made", "artificial"],
  "silk": ["silk", "silk fabric"],
  
  // Size/Measurement
  "large": ["l", "lg"],
  "medium": ["m", "med"],
  "small": ["s", "sm"],
  "extra large": ["xl", "extra-large"],
  "extra small": ["xs", "extra-small"],
  
  // More Fashion
  "jacket": ["coat", "outerwear"],
  "coat": ["jacket", "outerwear"],
  "dress": ["dress", "gown", "frock"],
  "gown": ["dress", "frock"],
  "shirt": ["shirt", "blouse", "top"],
  "blouse": ["shirt", "top"],
  "jeans": ["jeans", "denim", "denim pants"],
  "denim": ["jeans", "denim pants"],
  "boots": ["boots", "boot", "footwear"],
  "sandals": ["sandals", "flip flops", "flip-flops"],
  "flip flops": ["sandals", "flip-flops"],
  
  // More Beauty
  "shampoo": ["shampoo", "hair wash"],
  "conditioner": ["conditioner", "hair conditioner"],
  "serum": ["serum", "face serum", "treatment"],
  "sunscreen": ["sunscreen", "sunblock", "spf"],
  "sunblock": ["sunscreen", "spf"],
  "moisturizer": ["moisturizer", "moisturiser", "lotion", "cream"],
  "lotion": ["moisturizer", "moisturiser", "cream"],
  
  // More Electronics
  "tablet": ["tablet", "ipad", "tablet computer"],
  "keyboard": ["keyboard", "keypad"],
  "mouse": ["mouse", "computer mouse"],
  "monitor": ["monitor", "screen", "display"],
  "screen": ["monitor", "display"],
  "speaker": ["speaker", "audio speaker"],
  "cable": ["cable", "cord", "wire"],
  "cord": ["cable", "wire"],
  
  // More Home
  "bed": ["bed", "mattress", "bed frame"],
  "mattress": ["bed", "mattress"],
  "table": ["table", "desk"],
  "desk": ["table", "desk"],
  "chair": ["chair", "seat"],
  "lamp": ["lamp", "light", "lighting"],
  "light": ["lamp", "lighting"],
  "rug": ["rug", "carpet", "mat"],
  "carpet": ["rug", "mat"],
  "blanket": ["blanket", "throw", "cover"],
  "throw": ["blanket", "cover"],
  
  // More Food
  "pasta": ["pasta", "noodles"],
  "noodles": ["pasta", "noodles"],
  "rice": ["rice", "grain"],
  "bread": ["bread", "loaf"],
  "cheese": ["cheese", "dairy"],
  "milk": ["milk", "dairy"],
  "juice": ["juice", "drink", "beverage"],
  "drink": ["juice", "beverage"],
  
  // More Automotive
  "battery": ["battery", "car battery"],
  "tire": ["tire", "tyre", "wheel"],
  "wheel": ["tire", "tyre"],
  "oil": ["oil", "motor oil", "engine oil"],
  "filter": ["filter", "air filter"],
  
  // General/Common
  "diaper": ["nappy"],
  "nappy": ["diaper"],
  "stroller": ["pushchair", "buggy", "pram"],
  "pushchair": ["stroller", "buggy"],
  "pacifier": ["dummy", "soother"],
  "dummy": ["pacifier", "soother"],
  "gift": ["present", "gift"],
  "present": ["gift"],
  "sale": ["discount", "deal", "offer"],
  "discount": ["sale", "deal", "offer"],
  "deal": ["sale", "discount", "offer"],
};

/**
 * Generic abbreviation mappings (industry-agnostic, conservative)
 * Only includes common abbreviations that are safe to expand
 */
const ABBREVIATION_MAP: Record<string, string> = {
  // Electronics
  "tv": "television",
  "usb": "usb", // Keep as-is (already lowercase)
  "ssd": "solid state drive",
  "ram": "memory",
  "led": "led", // Keep as-is
  "hdmi": "hdmi", // Keep as-is
  "oled": "oled", // Keep as-is
  "lcd": "lcd", // Keep as-is
  "wifi": "wireless fidelity",
  "bluetooth": "bluetooth", // Keep as-is
  "cpu": "processor",
  "gpu": "graphics card",
  "ram": "memory",
  
  // Beauty/Cosmetics
  "spf": "sun protection factor",
  "edp": "eau de parfum",
  "edt": "eau de toilette",
  "uv": "ultraviolet",
  
  // Fashion/Sizes
  "xs": "extra small",
  "s": "small",
  "m": "medium",
  "l": "large",
  "xl": "extra large",
  "xxl": "extra extra large",
  "xxxl": "extra extra extra large",
  
  // General
  "etc": "etcetera",
  "vs": "versus",
  "approx": "approximately",
  "max": "maximum",
  "min": "minimum",
  "qty": "quantity",
  "pcs": "pieces",
};

/**
 * Common typos mapping (industry-agnostic)
 * Handles frequent misspellings that users might type across all industries
 */
const TYPO_MAP: Record<string, string> = {
  // Perfume/Beauty
  "pefrume": "perfume",
  "perfum": "perfume",
  "fragance": "fragrance",
  "lipstik": "lipstick",
  "mascara": "mascara", // Already correct, but common search
  "moisturiser": "moisturizer", // UK spelling, but also common typo
  "shampoo": "shampoo", // Common search
  
  // Fashion
  "sneekers": "sneakers",
  "sneakers": "sneakers", // Common search
  "trouser": "trousers",
  "jean": "jeans",
  "pant": "pants",
  "shirt": "shirt", // Common search
  
  // Electronics
  "headphone": "headphones",
  "earbud": "earbuds",
  "charger": "charger", // Common search
  "laptop": "laptop", // Common search
  "phone": "phone", // Common search
  
  // Home
  "sofa": "sofa", // Common search
  "couch": "couch", // Common search
  "pillow": "pillow", // Common search
  "blanket": "blanket", // Common search
  
  // Food
  "cookie": "cookie", // Common search
  "chips": "chips", // Common search
  
  // General spelling errors
  "reciept": "receipt",
  "seperate": "separate",
  "occured": "occurred",
  "accomodate": "accommodate",
  "definately": "definitely",
  "neccessary": "necessary",
  "occassion": "occasion",
  "embarass": "embarrass",
  "millenium": "millennium",
  "maintainance": "maintenance",
  "priviledge": "privilege",
  "existance": "existence",
};

/**
 * Expand term morphology: plural/singular, hyphen/space variants
 */
export function expandMorphology(term: string): Set<string> {
  const variants = new Set<string>();
  const normalized = term.toLowerCase().trim();
  
  if (!normalized || normalized.length < 2) {
    variants.add(normalized);
    return variants;
  }
  
  variants.add(normalized);
  
  // Hyphen/space variants: "t-shirt" <-> "tshirt" <-> "t shirt"
  if (normalized.includes("-")) {
    variants.add(normalized.replace(/-/g, " "));
    variants.add(normalized.replace(/-/g, ""));
  }
  if (normalized.includes(" ")) {
    variants.add(normalized.replace(/\s+/g, "-"));
    variants.add(normalized.replace(/\s+/g, ""));
  }
  if (!normalized.includes("-") && !normalized.includes(" ") && normalized.length > 3) {
    // Try adding hyphen/space for compound words (conservative)
    // Only for common patterns like "tshirt" -> "t-shirt", "t shirt"
    if (normalized.length >= 4 && /^[a-z]{1,3}[a-z]{3,}$/.test(normalized)) {
      // Very conservative: only if it looks like a compound
      // Skip for now to avoid false positives
    }
  }
  
  // Plural/singular variants
  // Handle plural forms ending in "es" (e.g., "coats" -> "coat", "boxes" -> "box")
  if (normalized.endsWith("es") && normalized.length > 4) {
    const singular = normalized.slice(0, -2);
    if (singular.length >= 2) {
      variants.add(singular);
    }
  }
  // Handle plural forms ending in "s" (e.g., "shoes" -> "shoe")
  else if (normalized.endsWith("s") && normalized.length > 3) {
    const singular = normalized.slice(0, -1);
    if (singular.length >= 2) {
      variants.add(singular);
    }
  }
  // Handle singular -> plural: add "s" or "es"
  else {
    // Words ending in x, z, ch, sh -> add "es"
    if (/[xz]|[cs]h$/.test(normalized)) {
      variants.add(normalized + "es");
    } else {
      variants.add(normalized + "s");
    }
  }
  
  // Special case: "eau-de-parfum" variants
  if (normalized.includes("eau") && normalized.includes("parfum")) {
    variants.add("eau de parfum");
    variants.add("eau-de-parfum");
    variants.add("edp");
    // Also add "perfume" as a related term (eau de parfum is a type of perfume)
    variants.add("perfume");
  }
  if (normalized.includes("eau") && normalized.includes("toilette")) {
    variants.add("eau de toilette");
    variants.add("eau-de-toilette");
    variants.add("edt");
    // Also add "perfume" as a related term
    variants.add("perfume");
  }
  
  // Special case: "perfume" related terms
  if (normalized === "perfume" || normalized === "perfumes") {
    // Add fragrance as synonym (industry-agnostic: perfume and fragrance are often used interchangeably)
    variants.add("fragrance");
    variants.add("fragrances");
    // Add EDP/EDT as related (common perfume types)
    variants.add("edp");
    variants.add("edt");
    variants.add("eau de parfum");
    variants.add("eau de toilette");
    // Add French spelling variants (parfume/parfum - common in perfume industry)
    variants.add("parfume");
    variants.add("parfumes");
    variants.add("parfum");
    variants.add("parfums");
  }
  if (normalized === "fragrance" || normalized === "fragrances") {
    // Add perfume as synonym
    variants.add("perfume");
    variants.add("perfumes");
    // Also add French variants
    variants.add("parfume");
    variants.add("parfumes");
    variants.add("parfum");
    variants.add("parfums");
  }
  // Handle French spelling variants (parfume/parfum)
  if (normalized === "parfume" || normalized === "parfumes" || normalized === "parfum" || normalized === "parfums") {
    // Add English spelling
    variants.add("perfume");
    variants.add("perfumes");
    // Add fragrance as synonym
    variants.add("fragrance");
    variants.add("fragrances");
    // Add EDP/EDT
    variants.add("edp");
    variants.add("edt");
    variants.add("eau de parfum");
    variants.add("eau de toilette");
  }
  
  // Handle common typos
  if (TYPO_MAP[normalized]) {
    const corrected = TYPO_MAP[normalized];
    variants.add(corrected);
    // Also add morphology variants of the corrected term
    if (corrected.endsWith("s")) {
      variants.add(corrected.slice(0, -1)); // singular
    } else {
      variants.add(corrected + "s"); // plural
    }
  }
  
  return variants;
}

/**
 * Expand multi-lingual variants (Spanish, French, German, Italian, Portuguese, etc.)
 */
export function expandMultilingual(term: string): Set<string> {
  const variants = new Set<string>();
  const normalized = term.toLowerCase().trim();
  
  variants.add(normalized);
  
  // Check if term has multi-lingual variants
  if (MULTILINGUAL_MAP[normalized]) {
    for (const variant of MULTILINGUAL_MAP[normalized]) {
      variants.add(variant.toLowerCase());
      // Also add with accents normalized (for better matching)
      const normalizedVariant = variant.toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, ""); // Remove accents
      if (normalizedVariant !== variant.toLowerCase()) {
        variants.add(normalizedVariant);
      }
    }
  }
  
  // Reverse lookup: if any multilingual term maps to this term, add other variants
  for (const [key, translations] of Object.entries(MULTILINGUAL_MAP)) {
    if (translations.includes(normalized) || translations.some(t => t.toLowerCase() === normalized)) {
      variants.add(key);
      // Add other translations from the same group
      for (const translation of translations) {
        if (translation.toLowerCase() !== normalized) {
          variants.add(translation.toLowerCase());
        }
      }
    }
  }
  
  return variants;
}

/**
 * Expand spelling/locale variants (UK/US/French)
 */
export function expandLocaleVariants(term: string): Set<string> {
  const variants = new Set<string>();
  const normalized = term.toLowerCase().trim();
  
  variants.add(normalized);
  
  // Check if term has locale variants
  if (LOCALE_VARIANTS[normalized]) {
    for (const variant of LOCALE_VARIANTS[normalized]) {
      variants.add(variant);
    }
  }
  
  return variants;
}

/**
 * Expand synonyms (industry-agnostic)
 * Handles common synonyms that are used interchangeably across industries
 */
export function expandSynonyms(term: string): Set<string> {
  const variants = new Set<string>();
  const normalized = term.toLowerCase().trim();
  
  variants.add(normalized);
  
  // Check if term has synonyms
  if (SYNONYM_MAP[normalized]) {
    for (const synonym of SYNONYM_MAP[normalized]) {
      variants.add(synonym);
      // Also add plural/singular variants of synonyms
      if (synonym.endsWith("s") && synonym.length > 4) {
        variants.add(synonym.slice(0, -1)); // singular
      } else if (synonym.length > 3) {
        variants.add(synonym + "s"); // plural
      }
    }
  }
  
  // Reverse lookup: if any synonym maps to this term, add the other synonyms
  for (const [key, synonyms] of Object.entries(SYNONYM_MAP)) {
    if (synonyms.includes(normalized)) {
      variants.add(key);
      // Add other synonyms from the same group
      for (const synonym of synonyms) {
        if (synonym !== normalized) {
          variants.add(synonym);
        }
      }
    }
  }
  
  return variants;
}

/**
 * Handle abbreviations: preserve all-caps tokens, optionally de-abbreviate
 * Also handles reverse expansion (full terms -> abbreviations)
 * @param term - The term to process
 * @param contextTerms - Optional context terms to infer domain
 * @returns Set of variants including original and de-abbreviated form if applicable
 */
export function expandAbbreviations(
  term: string,
  contextTerms: string[] = []
): Set<string> {
  const variants = new Set<string>();
  const normalized = term.toLowerCase().trim();
  const original = term.trim();
  
  variants.add(normalized);
  
  // Preserve all-caps tokens (length 2-6) as-is
  if (/^[A-Z]{2,6}$/.test(original)) {
    variants.add(original.toLowerCase());
    // Also try to de-abbreviate if we have a mapping
    if (ABBREVIATION_MAP[normalized]) {
      variants.add(ABBREVIATION_MAP[normalized]);
    }
  } else if (ABBREVIATION_MAP[normalized]) {
    // If term matches an abbreviation, add the expanded form
    variants.add(ABBREVIATION_MAP[normalized]);
  }
  
  // Reverse expansion: if term contains a full phrase that has an abbreviation, add the abbreviation
  // Example: "eau de parfum" -> "edp", "eau de toilette" -> "edt"
  if (normalized.includes("eau de parfum") || normalized.includes("eau-de-parfum")) {
    variants.add("edp");
  }
  if (normalized.includes("eau de toilette") || normalized.includes("eau-de-toilette")) {
    variants.add("edt");
  }
  
  return variants;
}

/**
 * Get LLM-generated synonyms for a term (with caching)
 * Cache key: shopId + term (30 days)
 */
export async function expandSynonymsLLM(
  term: string,
  shopId: string,
  maxSynonyms: number = 6
): Promise<string[]> {
  const cacheKey = `${shopId}:${term.toLowerCase()}`;
  const cacheExpiryDays = 30;
  
  try {
    // Check cache
    const cached = await prisma.queryExpansionCache.findUnique({
      where: { cacheKey },
    });
    
    if (cached && cached.expiresAt > new Date()) {
      const synonyms = JSON.parse(cached.synonymsJson || "[]");
      return Array.isArray(synonyms) ? synonyms.slice(0, maxSynonyms) : [];
    }
    
    // Generate synonyms via LLM
    const synonyms = await generateSynonymsViaLLM(term, maxSynonyms);
    
    // Cache result
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + cacheExpiryDays);
    
    await prisma.queryExpansionCache.upsert({
      where: { cacheKey },
      create: {
        cacheKey,
        shopId,
        term: term.toLowerCase(),
        synonymsJson: JSON.stringify(synonyms),
        expiresAt,
      },
      update: {
        synonymsJson: JSON.stringify(synonyms),
        expiresAt,
      },
    });
    
    return synonyms;
  } catch (error) {
    console.warn(`[Expansion] LLM synonym generation failed for term="${term}":`, error);
    return [];
  }
}

/**
 * Generate synonyms via OpenAI LLM
 */
async function generateSynonymsViaLLM(
  term: string,
  maxSynonyms: number
): Promise<string[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return [];
  }
  
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  
  const prompt = `Return up to ${maxSynonyms} common synonyms, aliases, regional variants, abbreviations, multilingual terms (Spanish, French, German, Italian, Portuguese, etc.), and near-equivalents that shoppers might use when searching for products containing the term "${term}".

Rules:
- Include abbreviations and common phrasing variations
- Include regional spelling variants (UK/US)
- Include multilingual terms (Spanish, French, German, Italian, Portuguese, Dutch, etc.)
- Include common marketplace/retailer terms
- Do NOT invent unrelated terms
- Return ONLY a JSON array of strings, no explanation

Example for "trainers":
["sneakers", "athletic shoes", "running shoes", "gym shoes", "trainers", "kicks"]

Example for "moisturizer":
["moisturiser", "moisturizing cream", "hydrating cream", "face cream", "lotion"]

Example for "shoes" (multilingual):
["zapatos", "chaussures", "schuhe", "scarpe", "sapatos", "schoenen"]

Return JSON array:`;

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "You are a helpful assistant that returns only valid JSON arrays." },
          { role: "user", content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 200,
      }),
    });
    
    if (!response.ok) {
      return [];
    }
    
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      return [];
    }
    
    // Parse JSON array
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((s: any) => typeof s === "string" && s.trim().length > 0)
        .map((s: string) => s.trim().toLowerCase())
        .slice(0, maxSynonyms);
    }
    
    return [];
  } catch (error) {
    console.warn(`[Expansion] LLM API error for term="${term}":`, error);
    return [];
  }
}

/**
 * Full term expansion pipeline
 * Combines morphology, locale variants, abbreviations, and optionally LLM synonyms
 */
export async function expandTerm(
  term: string,
  options: {
    shopId?: string;
    contextTerms?: string[];
    includeLLMSynonyms?: boolean;
    maxLLMSynonyms?: number;
  } = {}
): Promise<{
  canonical: string;
  expanded: Set<string>;
  localePairsUsed: string[];
  abbrevPreserved: string[];
}> {
  const { shopId, contextTerms = [], includeLLMSynonyms = false, maxLLMSynonyms = 6 } = options;
  
  const canonical = term.toLowerCase().trim();
  const expanded = new Set<string>();
  const localePairsUsed: string[] = [];
  const abbrevPreserved: string[] = [];
  
  // Step 1: Morphology expansion
  const morphVariants = expandMorphology(canonical);
  for (const variant of morphVariants) {
    expanded.add(variant);
  }
  
  // Step 2: Locale variants (for each morph variant)
  for (const morphVariant of morphVariants) {
    const localeVariants = expandLocaleVariants(morphVariant);
    for (const localeVariant of localeVariants) {
      expanded.add(localeVariant);
      if (localeVariant !== morphVariant && LOCALE_VARIANTS[morphVariant]) {
        localePairsUsed.push(`${morphVariant}->${localeVariant}`);
      }
    }
  }
  
  // Step 2.5: Multi-lingual expansion (Spanish, French, German, Italian, Portuguese, etc.)
  const multilingualVariants = expandMultilingual(canonical);
  for (const multilingualVariant of multilingualVariants) {
    expanded.add(multilingualVariant);
    // Also expand morphology for multilingual variants
    const multilingualMorph = expandMorphology(multilingualVariant);
    for (const variant of multilingualMorph) {
      expanded.add(variant);
    }
  }
  
  // Step 3: Abbreviation handling
  const abbrevVariants = expandAbbreviations(term, contextTerms);
  for (const abbrevVariant of abbrevVariants) {
    expanded.add(abbrevVariant);
    if (abbrevVariant !== canonical && /^[A-Z]{2,6}$/.test(term)) {
      abbrevPreserved.push(term);
    }
  }
  
  // Note: Reverse abbreviation expansion is now handled in expandAbbreviations()
  
  // Step 3.5: Industry-agnostic synonym expansion (built-in synonyms)
  const synonymVariants = expandSynonyms(canonical);
  for (const synonymVariant of synonymVariants) {
    expanded.add(synonymVariant);
    // Also expand morphology for synonyms
    const synonymMorph = expandMorphology(synonymVariant);
    for (const variant of synonymMorph) {
      expanded.add(variant);
    }
    // Also expand locale variants for synonyms
    const synonymLocale = expandLocaleVariants(synonymVariant);
    for (const variant of synonymLocale) {
      expanded.add(variant);
    }
  }
  
  // Step 4: LLM synonyms (if enabled and shopId provided)
  if (includeLLMSynonyms && shopId) {
    const llmSynonyms = await expandSynonymsLLM(canonical, shopId, maxLLMSynonyms);
    for (const synonym of llmSynonyms) {
      // Also expand morphology for synonyms
      const synonymMorph = expandMorphology(synonym);
      for (const variant of synonymMorph) {
        expanded.add(variant);
      }
    }
  }
  
  return {
    canonical,
    expanded,
    localePairsUsed: Array.from(new Set(localePairsUsed)),
    abbrevPreserved: Array.from(new Set(abbrevPreserved)),
  };
}

/**
 * Expand multiple terms (batch expansion)
 */
export async function expandTerms(
  terms: string[],
  options: {
    shopId?: string;
    contextTerms?: string[];
    includeLLMSynonyms?: boolean;
    maxLLMSynonyms?: number;
  } = {}
): Promise<{
  canonicalTerms: string[];
  expandedTerms: Set<string>;
  queryTokens: string[];
  localePairsUsed: string[];
  abbrevPreserved: string[];
}> {
  const canonicalTerms = terms.map(t => t.toLowerCase().trim()).filter(t => t.length > 0);
  const expandedTerms = new Set<string>();
  const queryTokens: string[] = [];
  const allLocalePairs: string[] = [];
  const allAbbrevPreserved: string[] = [];
  
  for (const term of canonicalTerms) {
    const expansion = await expandTerm(term, options);
    
    // Add all expanded variants
    for (const variant of expansion.expanded) {
      expandedTerms.add(variant);
      // Add to query tokens if meaningful (length >= 2, not just stopwords)
      if (variant.length >= 2) {
        queryTokens.push(variant);
      }
    }
    
    allLocalePairs.push(...expansion.localePairsUsed);
    allAbbrevPreserved.push(...expansion.abbrevPreserved);
  }
  
  return {
    canonicalTerms,
    expandedTerms,
    queryTokens: Array.from(new Set(queryTokens)),
    localePairsUsed: Array.from(new Set(allLocalePairs)),
    abbrevPreserved: Array.from(new Set(allAbbrevPreserved)),
  };
}

