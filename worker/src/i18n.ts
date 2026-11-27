// Multilingual support for the 20 most spoken languages worldwide.
// Provides language normalization, per-language glue words (for fluency gates),
// framing-leak patterns (greetings / sign-offs), and sentence formatting rules.

export const SUPPORTED_LANG_CODES = [
	'en',
	'zh',
	'hi',
	'es',
	'fr',
	'ar',
	'bn',
	'pt',
	'ru',
	'ur',
	'id',
	'de',
	'ja',
	'sw',
	'mr',
	'te',
	'tr',
	'ta',
	'vi',
	'ko',
] as const;

export type SupportedLang = (typeof SUPPORTED_LANG_CODES)[number];

export interface LanguageMeta {
	code: SupportedLang;
	name: string;
	nativeName: string;
	rtl: boolean;
	cjk: boolean;
	sentenceEnd: string;
	joiner: string;
	glueWords: ReadonlySet<string>;
	greetingOpenRe: RegExp;
	thanksCloseRe: RegExp;
	signoffCloseRe: RegExp;
}

export const TX_DETAIL_PREFIX: Record<SupportedLang, string> = {
	en: 'Please also note the following details:',
	zh: '请同时留意以下详情：',
	hi: 'कृपया निम्नलिखित विवरण भी ध्यान में रखें:',
	es: 'Tenga en cuenta también los siguientes detalles:',
	fr: 'Veuillez également noter les détails suivants :',
	ar: 'يرجى أيضًا ملاحظة التفاصيل التالية:',
	bn: 'অনুগ্রহ করে নিম্নলিখিত বিবরণগুলোও লক্ষ্য করুন:',
	pt: 'Observe também os seguintes detalhes:',
	ru: 'Также обратите внимание на следующие детали:',
	ur: 'براہ کرم درج ذیل تفصیلات بھی نوٹ کریں:',
	id: 'Harap perhatikan juga detail berikut:',
	de: 'Bitte beachten Sie außerdem folgende Details:',
	ja: 'あわせて以下の詳細もご確認ください：',
	sw: 'Tafadhali pia kumbuka maelezo yafuatayo:',
	mr: 'कृपया खालील तपशीलही लक्षात घ्या:',
	te: 'దయచేసి ఈ క్రింది వివరాలను కూడా గమనించండి:',
	tr: 'Lütfen şu ayrıntıları da dikkate alın:',
	ta: 'பின்வரும் விவரங்களையும் தயவுசெய்து கவனிக்கவும்:',
	vi: 'Vui lòng lưu ý thêm các chi tiết sau:',
	ko: '다음 세부 정보도 함께 참고해 주세요:',
};

const EN_GLUE = new Set(
	(
		'a,an,the,and,or,but,to,of,in,on,at,by,for,with,from,is,are,was,were,' +
		'be,been,am,it,its,as,so,we,our,you,your,they,their,he,she,his,her,' +
		'him,us,this,that,these,those,will,can,have,has,had,do,does,if,then,' +
		'than,when,which,who,whom,how,not,any,all,each,every,more,most,into,' +
		'over,under,through,during,before,after,between,my,would,should,' +
		'there,here,what'
	).split(','),
);

const setOf = (csv: string): ReadonlySet<string> =>
	new Set(csv.split(',').filter((w) => w.length > 0));

export const SUPPORTED_LANGUAGES: Record<SupportedLang, LanguageMeta> = {
	en: {
		code: 'en',
		name: 'English',
		nativeName: 'English',
		rtl: false,
		cjk: false,
		sentenceEnd: '.',
		joiner: ' ',
		glueWords: EN_GLUE,
		greetingOpenRe:
			/^(hi|hello|hey|greetings|good morning|good afternoon|good evening|thank you|thanks|dear)\b/i,
		thanksCloseRe: /\bthank( you|s)\b/i,
		signoffCloseRe:
			/(^|\n)\s*(best regards|sincerely|warm regards|kind regards|(customer )?support team)\b/im,
	},
	zh: {
		code: 'zh',
		name: 'Mandarin Chinese',
		nativeName: '中文',
		rtl: false,
		cjk: true,
		sentenceEnd: '。',
		joiner: '',
		glueWords: setOf(
			'的,了,在,是,和,与,或,请,您,我们,可以,通过,将,为,进行,以,到,对',
		),
		greetingOpenRe: /^(你好|您好|嗨|早上好|下午好|晚上好|亲爱的|感谢您|谢谢)/,
		thanksCloseRe: /(谢谢|感谢您|多谢)/,
		signoffCloseRe: /(^|\n)\s*(此致|敬礼|顺祝商祺|客服团队|客户支持团队)/m,
	},
	hi: {
		code: 'hi',
		name: 'Hindi',
		nativeName: 'हिन्दी',
		rtl: false,
		cjk: false,
		sentenceEnd: '।',
		joiner: ' ',
		glueWords: setOf(
			'के,की,का,को,में,से,पर,और,या,है,हैं,कृपया,आप,हम,अपने,लिए,द्वारा,करें,सकते',
		),
		greetingOpenRe: /^(नमस्ते|नमस्कार|हैलो|हाय|शुभ प्रभात|प्रिय|धन्यवाद)/,
		thanksCloseRe: /(धन्यवाद|शुक्रिया)/,
		signoffCloseRe: /(^|\n)\s*(सादर|भवदीय|ग्राहक सहायता टीम|सपोर्ट टीम)/m,
	},
	es: {
		code: 'es',
		name: 'Spanish',
		nativeName: 'Español',
		rtl: false,
		cjk: false,
		sentenceEnd: '.',
		joiner: ' ',
		glueWords: setOf(
			'el,la,los,las,un,una,de,del,en,con,por,para,y,o,que,es,son,su,sus,tu,tus,nuestro,nuestra,puede,puedes,favor,al,a,se,le,nos',
		),
		greetingOpenRe:
			/^(hola|buenos días|buenas tardes|buenas noches|estimad[oa]|gracias)\b/i,
		thanksCloseRe: /\bgracias\b/i,
		signoffCloseRe:
			/(^|\n)\s*(saludos cordiales|atentamente|un saludo|equipo de soporte)\b/im,
	},
	fr: {
		code: 'fr',
		name: 'French',
		nativeName: 'Français',
		rtl: false,
		cjk: false,
		sentenceEnd: '.',
		joiner: ' ',
		glueWords: setOf(
			'le,la,les,un,une,des,de,du,en,dans,sur,pour,par,avec,et,ou,est,sont,vous,votre,vos,nous,notre,nos,veuillez,pouvez,au,aux,à,ce,cette',
		),
		greetingOpenRe: /^(bonjour|bonsoir|salut|cher|chère|merci)\b/i,
		thanksCloseRe: /\bmerci\b/i,
		signoffCloseRe:
			/(^|\n)\s*(cordialement|bien cordialement|sincères salutations|équipe support|service client)\b/im,
	},
	ar: {
		code: 'ar',
		name: 'Arabic',
		nativeName: 'العربية',
		rtl: true,
		cjk: false,
		sentenceEnd: '.',
		joiner: ' ',
		glueWords: setOf(
			'في,من,إلى,على,عن,مع,أو,و,هو,هي,نحن,أنت,يرجى,يمكنك,عبر,لـ,بـ,هذا,هذه,التي,الذي',
		),
		greetingOpenRe:
			/^(مرحبا|مرحباً|أهلا|أهلاً|السلام عليكم|صباح الخير|مساء الخير|عزيزي|عزيزتي|شكرا|شكراً)/,
		thanksCloseRe: /(شكرا|شكراً|نشكرك)/,
		signoffCloseRe:
			/(^|\n)\s*(مع أطيب التحيات|تحياتي|فريق الدعم|خدمة العملاء)/m,
	},
	bn: {
		code: 'bn',
		name: 'Bengali',
		nativeName: 'বাংলা',
		rtl: false,
		cjk: false,
		sentenceEnd: '।',
		joiner: ' ',
		glueWords: setOf(
			'এর,এ,তে,কে,থেকে,জন্য,এবং,বা,অনুগ্রহ,করে,আপনি,আপনার,আমরা,আমাদের,হয়,পারেন,করুন,মাধ্যমে',
		),
		greetingOpenRe: /^(নমস্কার|হ্যালো|হাই|সুপ্রভাত|প্রিয়|ধন্যবাদ)/,
		thanksCloseRe: /(ধন্যবাদ)/,
		signoffCloseRe: /(^|\n)\s*(শুভেচ্ছান্তে|বিনীত|গ্রাহক সহায়তা দল|সাপোর্ট টিম)/m,
	},
	pt: {
		code: 'pt',
		name: 'Portuguese',
		nativeName: 'Português',
		rtl: false,
		cjk: false,
		sentenceEnd: '.',
		joiner: ' ',
		glueWords: setOf(
			'o,a,os,as,um,uma,de,do,da,dos,das,em,no,na,com,por,para,e,ou,é,são,seu,sua,seus,suas,nosso,nossa,você,pode,favor,ao,à,se',
		),
		greetingOpenRe:
			/^(olá|oi|bom dia|boa tarde|boa noite|prezad[oa]|obrigad[oa])\b/i,
		thanksCloseRe: /\bobrigad[oa]\b/i,
		signoffCloseRe:
			/(^|\n)\s*(atenciosamente|cordialmente|com os melhores cumprimentos|equipe de suporte)\b/im,
	},
	ru: {
		code: 'ru',
		name: 'Russian',
		nativeName: 'Русский',
		rtl: false,
		cjk: false,
		sentenceEnd: '.',
		joiner: ' ',
		glueWords: setOf(
			'и,в,на,по,с,для,от,до,или,не,вы,ваш,вашу,вашего,мы,наш,пожалуйста,можете,чтобы,через,к,у,из,за',
		),
		greetingOpenRe:
			/^(привет|здравствуйте|добрый день|доброе утро|добрый вечер|уважаемый|уважаемая|спасибо)/i,
		thanksCloseRe: /(спасибо|благодарим)/i,
		signoffCloseRe:
			/(^|\n)\s*(с уважением|всего доброго|служба поддержки|команда поддержки)/im,
	},
	ur: {
		code: 'ur',
		name: 'Urdu',
		nativeName: 'اردو',
		rtl: true,
		cjk: false,
		sentenceEnd: '۔',
		joiner: ' ',
		glueWords: setOf(
			'کے,کی,کا,کو,میں,سے,پر,اور,یا,ہے,ہیں,براہ,کرم,آپ,ہم,اپنے,لیے,ذریعے,کریں,سکتے',
		),
		greetingOpenRe: /^(السلام علیکم|ہیلو|ہائے|محترم|محترمہ|شکریہ)/,
		thanksCloseRe: /(شکریہ|تھینکس)/,
		signoffCloseRe: /(^|\n)\s*(نیک تمناؤں کے ساتھ|کسٹمر سپورٹ ٹیم|سپورٹ ٹیم)/m,
	},
	id: {
		code: 'id',
		name: 'Indonesian',
		nativeName: 'Bahasa Indonesia',
		rtl: false,
		cjk: false,
		sentenceEnd: '.',
		joiner: ' ',
		glueWords: setOf(
			'dan,atau,di,ke,dari,untuk,dengan,pada,yang,adalah,anda,kami,silakan,dapat,melalui,ini,itu,akan,oleh,dalam',
		),
		greetingOpenRe:
			/^(halo|hai|selamat pagi|selamat siang|selamat sore|selamat malam|terima kasih)\b/i,
		thanksCloseRe: /\bterima kasih\b/i,
		signoffCloseRe:
			/(^|\n)\s*(hormat kami|salam hangat|tim dukungan|tim layanan pelanggan)\b/im,
	},
	de: {
		code: 'de',
		name: 'German',
		nativeName: 'Deutsch',
		rtl: false,
		cjk: false,
		sentenceEnd: '.',
		joiner: ' ',
		glueWords: setOf(
			'der,die,das,den,dem,des,ein,eine,einen,einem,und,oder,in,im,an,am,auf,für,mit,von,zu,zum,zur,ist,sind,sie,ihr,ihre,wir,unser,bitte,können,über',
		),
		greetingOpenRe:
			/^(hallo|hi|guten morgen|guten tag|guten abend|sehr geehrte|vielen dank|danke)\b/i,
		thanksCloseRe: /\b(vielen dank|danke)\b/i,
		signoffCloseRe:
			/(^|\n)\s*(mit freundlichen grüßen|freundliche grüße|viele grüße|ihr support-team|kundenservice)\b/im,
	},
	ja: {
		code: 'ja',
		name: 'Japanese',
		nativeName: '日本語',
		rtl: false,
		cjk: true,
		sentenceEnd: '。',
		joiner: '',
		glueWords: setOf(
			'の,に,は,を,た,が,で,て,と,し,れ,さ,ある,いる,する,から,まで,より,ください,ます,です',
		),
		greetingOpenRe:
			/^(こんにちは|こんばんは|おはようございます|いつもご利用|ありがとう)/,
		thanksCloseRe: /(ありがとう|感謝いたします)/,
		signoffCloseRe:
			/(^|\n)\s*(よろしくお願いいたします|敬具|(カスタマー)?サポート(チーム)?)\s*[。．.!?]?\s*$/m,
	},
	sw: {
		code: 'sw',
		name: 'Swahili',
		nativeName: 'Kiswahili',
		rtl: false,
		cjk: false,
		sentenceEnd: '.',
		joiner: ' ',
		glueWords: setOf(
			'na,au,kwa,ya,wa,la,za,katika,kwenye,kutoka,hadi,ni,tafadhali,unaweza,tunaweza,yako,wako,wetu,yetu,ili,kama',
		),
		greetingOpenRe: /^(habari|hujambo|mambo|shikamoo|asante)\b/i,
		thanksCloseRe: /\basante\b/i,
		signoffCloseRe:
			/(^|\n)\s*(kwa heshima|timu ya msaada|huduma kwa wateja)\b/im,
	},
	mr: {
		code: 'mr',
		name: 'Marathi',
		nativeName: 'मराठी',
		rtl: false,
		cjk: false,
		sentenceEnd: '।',
		joiner: ' ',
		glueWords: setOf(
			'आणि,किंवा,मध्ये,साठी,पासून,वर,द्वारे,आहे,आहेत,कृपया,तुम्ही,तुमचे,आम्ही,आमचे,करा,शकता',
		),
		greetingOpenRe: /^(नमस्कार|नमस्ते|हॅलो|सुप्रभात|प्रिय|धन्यवाद)/,
		thanksCloseRe: /(धन्यवाद|आभारी)/,
		signoffCloseRe: /(^|\n)\s*(आपला विश्वासू|ग्राहक सहाय्य टीम|सपोर्ट टीम)/m,
	},
	te: {
		code: 'te',
		name: 'Telugu',
		nativeName: 'తెలుగు',
		rtl: false,
		cjk: false,
		sentenceEnd: '.',
		joiner: ' ',
		glueWords: setOf(
			'మరియు,లేదా,లో,కోసం,నుండి,ద్వారా,దయచేసి,మీరు,మీ,మేము,మా,ఉంది,ఉన్నాయి,చేయండి,గలరు',
		),
		greetingOpenRe: /^(నమస్కారం|నమస్తే|హలో|శుభోదయం|ప్రియమైన|ధన్యవాదాలు)/,
		thanksCloseRe: /(ధన్యవాదాలు)/,
		signoffCloseRe: /(^|\n)\s*(భవదీయులు|కస్టమర్ సపోర్ట్ టీమ్|సపోర్ట్ టీమ్)/m,
	},
	tr: {
		code: 'tr',
		name: 'Turkish',
		nativeName: 'Türkçe',
		rtl: false,
		cjk: false,
		sentenceEnd: '.',
		joiner: ' ',
		glueWords: setOf(
			've,veya,ile,için,bu,bir,da,de,lütfen,siz,sizin,biz,bizim,üzerinden,olarak,kadar,gibi,daha',
		),
		greetingOpenRe:
			/^(merhaba|selam|günaydın|iyi günler|iyi akşamlar|sayın|teşekkürler|teşekkür ederim)\b/i,
		thanksCloseRe: /\bteşekkür(ler| ederim| ederiz)\b/i,
		signoffCloseRe:
			/(^|\n)\s*(saygılarımızla|iyi günler dileriz|destek ekibi|müşteri hizmetleri)\b/im,
	},
	ta: {
		code: 'ta',
		name: 'Tamil',
		nativeName: 'தமிழ்',
		rtl: false,
		cjk: false,
		sentenceEnd: '.',
		joiner: ' ',
		glueWords: setOf(
			'மற்றும்,அல்லது,இல்,காக,இருந்து,மூலம்,தயவுசெய்து,நீங்கள்,உங்கள்,நாங்கள்,எங்கள்,உள்ளது,செய்யவும்,முடியும்',
		),
		greetingOpenRe: /^(வணக்கம்|ஹலோ|காலை வணக்கம்|அன்புள்ள|நன்றி)/,
		thanksCloseRe: /(நன்றி)/,
		signoffCloseRe: /(^|\n)\s*(இப்படிக்கு|வாடிக்கையாளர் சேவை குழு|ஆதரவு குழு)/m,
	},
	vi: {
		code: 'vi',
		name: 'Vietnamese',
		nativeName: 'Tiếng Việt',
		rtl: false,
		cjk: false,
		sentenceEnd: '.',
		joiner: ' ',
		glueWords: setOf(
			'và,hoặc,của,cho,với,tại,từ,đến,trong,trên,qua,là,được,vui,lòng,bạn,chúng,tôi,có,thể,sẽ,để',
		),
		greetingOpenRe: /^(xin chào|chào bạn|chào quý khách|kính gửi|cảm ơn)\b/i,
		thanksCloseRe: /\bcảm ơn\b/i,
		signoffCloseRe:
			/(^|\n)\s*(trân trọng|thân ái|đội ngũ hỗ trợ|chăm sóc khách hàng)\b/im,
	},
	ko: {
		code: 'ko',
		name: 'Korean',
		nativeName: '한국어',
		rtl: false,
		cjk: false,
		sentenceEnd: '.',
		joiner: ' ',
		glueWords: setOf(
			'및,또는,에서,으로,로,을,를,이,가,은,는,의,에,해,주세요,수,있습니다,위해,통해,고객님의',
		),
		greetingOpenRe:
			/^(안녕하세요|안녕하십니까|반갑습니다|감사합니다|고맙습니다)/,
		thanksCloseRe: /(감사합니다|고맙습니다)/,
		signoffCloseRe:
			/(^|\n)\s*(감사합니다|고객 지원팀|지원팀|고객센터)\s*[.!?]?\s*$/m,
	},
};

const NAME_TO_CODE: Record<string, SupportedLang> = {
	english: 'en',
	chinese: 'zh',
	mandarin: 'zh',
	'mandarin chinese': 'zh',
	hindi: 'hi',
	spanish: 'es',
	french: 'fr',
	arabic: 'ar',
	bengali: 'bn',
	portuguese: 'pt',
	russian: 'ru',
	urdu: 'ur',
	indonesian: 'id',
	german: 'de',
	japanese: 'ja',
	swahili: 'sw',
	marathi: 'mr',
	telugu: 'te',
	turkish: 'tr',
	tamil: 'ta',
	vietnamese: 'vi',
	korean: 'ko',
};

/** Normalize BCP-47 tags (e.g. 'es-MX', 'zh-CN', 'pt_BR') or language names
 * into a SupportedLang code. Returns undefined if unsupported. */
export function normalizeLang(input: string): SupportedLang | undefined {
	const cleaned = input.trim().toLowerCase().replace(/_/g, '-');
	if (cleaned.length === 0) {
		return undefined;
	}
	const primary = cleaned.split('-')[0] ?? '';
	if (primary in SUPPORTED_LANGUAGES) {
		return primary as SupportedLang;
	}
	return NAME_TO_CODE[cleaned];
}

export function listSupportedLanguages(): Array<{
	code: SupportedLang;
	name: string;
	nativeName: string;
	rtl: boolean;
}> {
	return SUPPORTED_LANG_CODES.map((code) => {
		const m = SUPPORTED_LANGUAGES[code];
		return {
			code: m.code,
			name: m.name,
			nativeName: m.nativeName,
			rtl: m.rtl,
		};
	});
}
