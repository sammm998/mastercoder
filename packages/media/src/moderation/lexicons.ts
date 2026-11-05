/**
 * Moderation lexicons (English + Swedish). Fragments are regex sources matched against normalised text
 * (lowercase, no diacritics: å/ä→a, ö→o; punctuation → spaces; leetspeak mapped). Each fragment is
 * anchored at a word start; fragments that must be whole words end in \b. Swedish compounds are matched
 * as prefixes (e.g. "rekryter" matches "rekryteringsaffisch").
 */

// ---------------- sexual content involving minors ----------------

export const SEXUAL_TERMS = [
  // en
  "sex\\b", "sexy", "sexual", "sexualis", "sexualiz", "sexting", "nude", "nudes\\b", "noods?\\b", "nudity", "nudify", "naked", "nsfw", "porn", "erotic",
  "lingerie", "topless", "bottomless", "undress", "striptease", "stripper", "seductive", "fetish", "xxx", "intercourse", "orgasm", "hentai", "explicit (content|image|photo|picture|scene|video)s?",
  "lewd", "nipple", "genital", "provocative pose", "sensual", "aroused", "horny", "masturbat", "molest", "rape\\b", "raped", "raping", "kinky", "bdsm", "bondage",
  "without (any )?clothes", "no clothes", "unclothed", "bare (skin|body|bodies)", "spread legs", "onlyfans", "boudoir", "in (her|his|their) underwear",
  // sv
  "sexig", "sexuell", "naken", "nakna\\b", "naket\\b", "nakenhet", "nakenbild", "porr", "erotisk", "underklader", "avklad", "kla av", "strippa",
  "samlag", "sensuell", "onaner", "forforisk", "oanstandig", "lattkladd", "utan klader", "valdt", "snuskig",
];

export const MINOR_TERMS = [
  // en
  "child\\b", "children", "childs?\\b", "childlike", "kid\\b", "kids\\b", "kiddie", "minor\\b", "minors\\b", "underage", "under age\\b", "teen\\b", "teens\\b",
  "teenage", "preteen", "pre teen", "tween", "young (girl|boy)s?\\b", "little (girl|boy)s?\\b", "school ?girl", "school ?boy", "toddler",
  "infant", "newborn", "loli\\b", "shota\\b", "jailbait", "juvenile", "prepubescent", "pubescent", "elementary school", "middle school",
  "grade schooler", "kindergart", "girl scout", "boy scout", "under (1[0-7]|[1-9])\\b",
  // sv
  "flick(a|or|an|orna)\\b", "pojk(e|ar|en|arna)\\b", "tonaring", "tonarig", "fortonaring", "minderarig", "skolflick", "skolpojk", "unge\\b", "ungar\\b",
  "ungen\\b", "smabarn", "spadbarn", "lagstadie", "mellanstadie", "hogstadie", "liten (flicka|pojke)", "lilla (flickan|pojken)", "dagisbarn", "forskolebarn",
];

/** Bare "barn" is Swedish for child but English for a farm building: only counted when the text looks Swedish. */
export const MINOR_TERMS_SV_ONLY = ["barn(et|en|s|a)?\\b", "barn[a-z]+"];

/** Age below 18 written as a number: "12 yo", "13-year-old", "15 år", "12-åring". */
export const MINOR_AGE = /\b([1-9]|1[0-7]) ?(yo|y o|yrs?|years?( old)?|year olds?|ar\b|ars|arig|aring(ar)?)\b/;

/** Blocked on their own (unambiguous CSAM terms). */
export const CSAM_STANDALONE = ["child ?porn", "kiddie ?porn", "barnporr", "pedo", "paedo", "pedofil", "pedophil", "paedophil", "lolicon", "shotacon", "csam\\b", "jailbait"];

// ---------------- real-person deepfakes ----------------

export const REAL_PEOPLE = [
  "taylor swift", "elon musk", "donald trump", "trump\\b", "joe biden", "biden\\b", "barack obama", "obama\\b", "michelle obama", "kamala harris",
  "vladimir putin", "putin\\b", "volodymyr zelensk", "zelensk", "xi jinping", "narendra modi", "emmanuel macron", "angela merkel", "olaf scholz",
  "ursula von der leyen", "keir starmer", "king charles", "prince william", "prince harry", "kate middleton", "meghan markle", "pope francis", "pope leo",
  "mark zuckerberg", "bill gates", "jeff bezos", "sam altman", "tim cook", "beyonce", "rihanna", "kim kardashian", "kanye west", "scarlett johansson",
  "emma watson", "tom cruise", "keanu reeves", "billie eilish", "ariana grande", "selena gomez", "lionel messi", "cristiano ronaldo",
  // Nordic public figures
  "greta thunberg", "ulf kristersson", "magdalena andersson", "stefan lofven", "jimmie akesson", "ebba busch", "carl xvi gustaf", "kung carl gustaf",
  "kronprinsessan victoria", "crown princess victoria", "prinsessan madeleine", "zlatan", "zara larsson", "alicia vikander", "pewdiepie",
  "felix kjellberg", "mette frederiksen", "jonas gahr store", "sanna marin", "petteri orpo",
];

/** Private individuals referenced personally (deepfake of a real, identifiable person). */
export const PERSONAL_TARGETS = [
  "my (ex|ex girlfriend|ex boyfriend|ex wife|ex husband|coworker|co worker|colleague|boss|classmate|neighbou?r|teacher|crush|friend|sister|brother|mom|mother|wife|girlfriend|boyfriend|student)s?\\b",
  "(a|this) real person", "real people", "this (girl|woman|guy|man|person) from", "(this|the) (photo|picture|image) of (my|her|him|this person)",
  "(min|mitt|mina) (ex|kollega|chef|klasskompis|granne|larare|flickvan|pojkvan|syster|bror|mamma|fru|man|kompis|elev)\\b",
  "en (verklig|riktig) person", "riktiga personer",
];

export const DEEPFAKE_ACTIONS = [
  "face ?swap", "faceswap", "swap (the |his |her |their )?faces?", "replace (the |his |her |their )?face", "put (his|her|their|the) face", "deep ?fake",
  "nude", "naked", "undress", "nudify", "without clothes", "remove (her|his|their) clothes", "fake (photo|image|picture|video|nude|news|selfie|screenshot|interview)",
  "impersonat", "pretend(ing)? to be", "posing as", "make (it|this|me|him|her) look like", "look (exactly )?like", "lookalike", "look alike", "voice clon",
  "clone (his|her|their) voice", "arrested", "in (jail|prison)", "in handcuffs", "drunk\\b", "kissing", "in bed with", "sexy", "lingerie",
  "photorealistic", "realistic (photo|image|picture)", "hyperrealistic", "endorsing", "endorsement",
  // sv
  "byt(a)? ansikte", "ansiktsbyt", "satt (hans|hennes|deras) ansikte", "naken", "nakna\\b", "kla av", "avklad", "falsk(a)? (bild|video|nyhet)", "fejk",
  "forfalska", "utge(r)? sig for", "latsas vara", "fa (det|den|mig|honom|henne) att se ut som", "se ut (precis |exakt )?som", "dubbelgangare", "gripen",
  "arresterad", "i fangelse", "berusad", "kyss", "i sangen med", "sexig", "fotorealistisk", "realistisk (bild|foto)",
];

/** Strong non-consensual-imagery intents: blocked when an image is attached even without a name. */
export const IMAGE_ABUSE_ACTIONS = [
  "face ?swap", "faceswap", "swap (the |his |her |their )?faces?", "undress", "nudify", "remove (her|his|their|the) clothes", "make (her|him|them) naked",
  "without clothes", "kla av", "gor (henne|honom) naken", "byt(a)? ansikte", "ansiktsbyt",
];

export const DEEPFAKE_STANDALONE = ["deep ?fake (of|av) ", "nudify", "undress (this|her|him|the) (photo|picture|image|girl|woman|man)"];

// ---------------- brand impersonation ----------------

export const BRANDS = [
  "paypal", "google", "gmail", "microsoft", "outlook", "office 365", "microsoft 365", "facebook", "instagram", "whatsapp", "netflix", "spotify",
  "ikea", "volvo", "klarna", "swish", "bank ?id\\b", "nordea", "swedbank", "handelsbanken", "danske bank", "skatteverket", "postnord",
  "forsakringskassan", "kronofogden", "polisen", "coca cola", "nike\\b", "adidas", "mastercard", "american express", "amex\\b", "dhl\\b", "fedex",
  "bank of america", "wells fargo", "hsbc", "revolut", "linkedin", "twitter", "tiktok", "roblox", "coinbase", "binance", "metamask", "icloud",
  "apple id", "iphone", "macbook", "dropbox", "docusign", "telia", "tele2", "systembolaget", "openai", "chatgpt", "anthropic", "amazon prime", "aws\\b",
];

/** Ambiguous brand names matched case-sensitively in the original text ("Apple" vs "apple pie"). */
export const BRANDS_CASE_SENSITIVE = ["Apple", "Amazon", "Meta", "Visa", "Chase", "Steam", "SEB", "ICA", "UPS", "X Corp"];

export const BRAND_ABUSE_PATTERNS = [
  "logo", "logotyp", "official", "officiell", "login", "log in", "sign in", "signin", "logga in", "inloggning", "phishing", "natfisk",
  "verify (your )?(account|identity|payment)", "account (verification|suspended|locked|blocked)", "verifiera (ditt )?konto", "password", "losenord",
  "reset (your )?password", "credentials", "security alert", "sakerhetsvarning", "invoice", "faktura", "refund", "aterbetalning", "gift ?card", "presentkort",
  "customer (support|service) (page|chat|site)", "kundtjanst", "payment page", "checkout page", "betalsida", "branded email", "email template",
  "e ?postmall", "website clone", "clone (of )?(the |their )?(site|website|app|page)", "copy (of )?(the |their )?(site|website|page)", "exact replica",
  "kopia av", "trademark", "varumarke", "letterhead", "brevhuvud", "app icon", "appikon", "impersonat", "utge sig",
];

export const PHISHING_STANDALONE = [
  "fake ([a-z]+ )?(login|log in|sign in|signin|bank|banking|payment) (page|form|site|website|screen)", "credential harvest", "stjal(a)? (inloggning|losenord|kortuppgifter)",
  "phishing (page|site|website|email|mail|kit|sms)", "natfiskesida", "falsk inloggningssida",
];

export const PHISHING_EDUCATION = ["awareness", "training", "avoid", "spot\\b", "recogni[sz]e", "kanna igen", "undvika", "utbildning", "medvetenhet", "warning about", "varna for"];

// ---------------- violent extremism ----------------

export const EXTREMIST_ORGS = [
  "isis\\b", "isil\\b", "daesh", "islamic state", "islamiska staten", "al ?qa[ei]da", "al ?shabaab", "boko haram", "hamas\\b", "hezbollah", "hizbollah",
  "taliban", "nordic resistance movement", "nordiska motstandsrorelsen", "atomwaffen", "kkk\\b", "ku klux klan", "combat 18", "blood (and )?honou?r",
  "national socialist movement", "golden dawn", "proud boys", "patriot front", "feuerkrieg", "order of nine angles", "o9a\\b", "hitler ?youth",
  "hitlerjugend", "waffen ss", "nazi", "neo ?nazi", "nynazist", "jihadi", "jihadist", "white supremac", "vit makt",
];
export const EXTREMIST_ORGS_CASE_SENSITIVE = ["NMR", "PKK"];

/** Propaganda/presentation patterns: educational context can make these acceptable. */
export const EXTREMIST_PROPAGANDA = [
  "propaganda", "flag", "banner", "poster", "flyer", "leaflet", "sticker", "logo", "emblem", "insignia", "uniform", "rally", "parade", "salute", "anthem",
  "swastika", "symbol", "flagga", "banderoll", "affisch", "flygblad", "klistermark", "hakkors", "symbol", "marsch",
];

/** Recruitment/glorification intents: blocked regardless of context. */
export const EXTREMIST_INTENT = [
  "recruit", "join (us|the|our)", "enlist", "manifesto", "glorif", "celebrat", "tribute", "hero", "martyr", "shahid", "beheading", "execution video",
  "attack (plan|video)", "call to (arms|jihad)", "rekryter", "anslut", "forharlig", "hylla", "hyllning", "hjalte", "manifest\\b", "kampa for",
];

export const EXTREMIST_STANDALONE = [
  "heil hitler", "sieg heil", "1488\\b", "14 88\\b", "14 words", "fourteen words", "white power", "white genocide", "great replacement", "race war",
  "rahowa", "jihad recruit", "terror(ist)? (attack )?(glorif|propaganda|recruit)",
];

export const ATTACKERS = [
  "breivik", "brenton tarrant", "christchurch shooter", "dylann roof", "timothy mcveigh", "osama bin laden", "bin laden", "al baghdadi",
  "rakhmat akilov", "anton lundin pettersson", "utoya (attack|shooter|gunman)",
];
export const GLORIFY = ["glorif", "hero", "tribute", "saint\\b", "celebrat", "legend", "fan ?art", "meme", "idol", "hylla", "hyllning", "hjalte", "forharlig", "ikon"];

export const EDUCATIONAL_CONTEXT = [
  "history", "historical", "historic", "documentary", "museum", "education", "educational", "textbook", "lesson", "exhibit", "archive", "wwii", "ww2",
  "world war", "holocaust", "remembrance", "anti\\b", "anti ", "against", "opposing", "historia", "historisk", "dokumentar", "utbildning", "lektion",
  "larobok", "utstallning", "arkiv", "andra varldskriget", "mot (nazism|extremism|rasism|terror)", "news report", "nyhetsinslag",
];
