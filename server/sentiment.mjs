/**
 * Lexicon sentiment scorer tuned for chat / gaming / Discord register.
 * VADER-ish: negation window, boosters, dampeners, ALL CAPS, punctuation,
 * emoji and Discord custom-emoji support.
 *
 * Returns score in [-1, 1] plus a label and magnitude.
 */

// word weight  (roughly -4 .. +4)
const LEX_TEXT = `
good 1.9
great 3.1
excellent 3.2
amazing 3.2
awesome 3.1
incredible 2.9
fantastic 3.0
wonderful 2.7
brilliant 2.8
perfect 2.9
love 3.2
loved 2.9
loves 2.7
loving 2.6
lovely 2.5
adore 2.8
enjoy 2.2
enjoyed 2.3
enjoying 2.1
fun 2.3
funny 1.9
hilarious 2.6
lol 1.8
lmao 2.0
lmfao 2.2
haha 1.6
hahaha 1.9
hehe 1.4
nice 1.8
cool 1.7
sweet 1.9
dope 2.1
fire 2.4
lit 2.0
bussin 2.6
slaps 2.3
based 2.2
goat 2.5
goated 2.7
w 2.4
win 2.5
wins 2.3
winning 2.4
won 2.2
best 3.0
better 1.9
happy 2.7
glad 2.0
excited 2.4
exciting 2.3
hype 2.0
hyped 2.3
blessed 2.2
grateful 2.6
thankful 2.5
thanks 2.0
thank 1.9
thx 1.7
ty 1.5
appreciate 2.3
appreciated 2.2
welcome 1.6
congrats 2.6
congratulations 2.7
grats 1.8
proud 2.4
clean 1.7
satisfying 2.2
beautiful 2.7
gorgeous 2.8
cute 2.3
adorable 2.5
handsome 2.3
smart 2.1
clever 2.0
genius 2.6
talented 2.4
skilled 2.3
impressive 2.5
impressed 2.4
epic 2.6
legendary 2.8
insane 1.8
unreal 1.9
solid 1.8
valid 1.9
agree 1.9
agreed 1.9
exactly 1.6
true 1.5
correct 1.8
fair 1.4
deserved 1.8
help 1.5
helpful 2.2
helped 1.9
support 1.6
supportive 2.2
kind 2.1
kindness 2.6
wholesome 2.5
peace 2.0
peaceful 2.1
safe 1.8
comfy 2.0
cozy 2.1
chill 1.8
relaxing 2.2
relaxed 2.0
smile 2.1
smiling 2.2
laugh 2.0
laughing 2.1
progress 1.8
improved 2.0
improvement 1.9
upgrade 1.8
upgraded 1.9
fixed 1.7
solved 2.0
works 1.6
success 2.4
successful 2.3
succeeded 2.2
ready 1.4
bravo 2.4
cheers 2.0
hug 1.9
hugs 2.0
ok 1.0
okay 1.0
fine 0.6
improve 1.7
improving 1.8
sure 0.9
yes 1.0
yeah 0.8
yep 0.8
yay 2.0
woohoo 2.3
letsgo 2.2
pog 2.0
poggers 2.2
chad 1.8
rizz 1.4
peak 2.0
masterpiece 2.9
cinema 1.8
crisp 1.5
smooth 1.7
easy 1.4
worth 1.8
worthit 1.9
lucky 2.0
fortunate 2.1
hope 1.4
hopeful 1.9
optimistic 2.0
faith 1.3
trust 1.5
honest 1.6
respect 2.0
respected 1.9
legend 2.4
hero 2.3
saved 1.8
rescue 1.6
healed 2.2
healing 1.9
recovery 1.7
strong 1.9
stronger 2.1
brave 2.2
courageous 2.3
confident 2.0
calm 1.5
patient 1.6
generous 2.4
humble 1.9
mature 1.6
learn 1.5
learned 1.6
learning 1.5
curious 1.4
interesting 1.7
fascinating 2.4
insightful 2.3
thoughtful 2.1
clear 1.5
understandable 1.6
makesense 1.8
noworries 1.6
np 1.2
gg 1.8
wp 1.7
clutch 2.2
carry 1.4
carried 1.6
buff 1.8
op 1.4
goodjob 2.6
welldone 2.5
nocap 1.8
goated 2.7
fye 2.2
hard 0.6
sick 0.4
cracked 1.8
busted 0.9

bad -1.9
terrible -3.2
horrible -3.2
awful -3.0
trash -2.9
garbage -2.8
worst -3.2
worse -2.2
shit -2.4
shitty -2.8
crap -2.2
hate -2.9
hated -2.6
hates -2.6
hating -2.5
dislike -2.0
disgusting -3.0
gross -2.3
nasty -2.4
ugly -2.3
stupid -2.4
dumb -2.2
idiot -2.6
idiotic -2.5
moron -2.7
foolish -2.0
dumbass -2.7
clown -2.0
cringe -2.3
cringy -2.2
embarrassing -2.2
embarrassed -1.8
awkward -1.5
annoying -2.2
annoyed -2.0
irritating -2.1
frustrating -2.3
frustrated -2.2
angry -2.5
mad -2.0
furious -2.9
rage -2.7
toxic -2.7
salty -1.8
bitter -1.9
petty -1.7
rude -2.2
disrespectful -2.4
mean -2.1
cruel -2.7
evil -3.0
hateful -2.8
racist -3.5
sexist -3.4
homophobic -3.4
bigot -3.2
groomer -3.5
sus -1.6
suspicious -1.8
sketchy -1.9
weird -1.2
strange -1.0
wrong -2.0
incorrect -1.7
false -1.8
lie -2.3
lying -2.4
liar -2.6
lied -2.2
scam -2.8
scammed -2.7
scammer -2.9
fraud -2.7
cheat -2.4
cheater -2.6
cheated -2.4
betray -2.7
betrayed -2.8
betrayal -2.8
broken -2.2
bug -1.5
buggy -1.9
lag -1.4
laggy -1.8
lagging -1.6
crash -1.9
crashed -2.0
crashes -1.9
unplayable -2.9
unfinished -1.8
rushed -1.7
overpriced -2.1
paywall -1.8
greedy -2.5
mid -1.8
overrated -2.0
boring -2.2
bored -1.6
bland -1.7
dull -1.8
slow -1.5
useless -2.7
pointless -2.3
waste -2.4
wasted -2.3
wasting -2.2
regret -2.4
disappointed -2.4
disappointing -2.5
disappointment -2.5
letdown -2.3
sad -2.0
unhappy -2.2
depressed -2.6
depressing -2.6
cry -1.0
tears -0.8
hurt -2.1
hurts -2.0
pain -2.2
painful -2.3
suffer -2.6
suffering -2.7
tired -1.4
exhausted -1.9
stressed -2.2
stress -2.0
anxious -2.0
anxiety -2.2
scared -2.2
scary -1.8
afraid -2.0
fear -2.1
terrified -2.8
worried -1.9
worry -1.7
nervous -1.7
panic -2.3
kill -2.6
killed -2.4
murder -3.3
death -2.6
fail -2.5
failed -2.4
failure -2.6
failing -2.3
lose -2.2
losing -2.3
lost -2.0
loss -2.2
loser -2.5
defeat -2.1
missed -1.6
missing -1.4
forgot -1.3
forget -1.1
ignore -1.7
ignored -1.9
ignoring -1.8
blocked -1.6
banned -2.0
ban -1.8
kicked -1.5
muted -1.4
noob -1.7
ratio -1.8
l -2.2
cap -1.2
copium -1.9
cope -1.4
delusion -2.4
delusional -2.5
gaslight -2.6
manipulated -2.4
unfair -2.2
rigged -2.5
rig -2.0
ugh -1.5
ew -1.8
eww -1.8
yuck -2.0
yikes -1.5
oof -1.2
rip -1.2
damn -0.8
hell -0.6
fucked -2.4
screwed -2.1
screw -1.9
sucks -2.4
suck -2.2
sucked -2.3
ass -1.6
asshole -2.9
bitch -2.6
bastard -2.6
prick -2.4
dick -2.0
dickhead -2.9
cunt -3.3
wtf -1.4
wth -1.0
smh -1.2
bruh -0.6
confusing -1.6
confused -1.4
unclear -1.4
complicated -1.2
difficult -1.3
impossible -2.2
hopeless -2.6
helpless -2.4
stuck -1.7
trapped -2.0
alone -1.4
lonely -2.1
abandoned -2.4
rejected -2.4
rejection -2.4
dumped -2.2
ghosted -2.0
fired -2.2
poor -1.6
sleepy -1.0
tryhard -1.2
sweat -0.8
nerf -1.8
nerfed -1.8
crutch -1.4
tilted -1.8
tilt -1.6
throwing -1.4
cooked -2.2
int -1.4
afk -1.2
`;

const LEXICON = new Map();
for (const line of LEX_TEXT.trim().split('\n')) {
  const [word, value] = line.trim().split(/\s+/);
  if (word && value) LEXICON.set(word, Number(value));
}

const NEGATORS = new Set([
  'not', 'no', 'never', 'none', 'nobody', 'nothing', 'neither', 'nor',
  "isn't", 'isnt', "aren't", 'arent', "wasn't", 'wasnt', "weren't", 'werent',
  "don't", 'dont', "doesn't", 'doesnt', "didn't", 'didnt', "can't", 'cant',
  'cannot', "won't", 'wont', "wouldn't", 'wouldnt', "shouldn't", 'shouldnt',
  "couldn't", 'couldnt', "ain't", 'aint', 'hardly', 'barely', 'scarcely',
  'without', 'lacks', 'lacking',
]);

const BOOSTERS = new Set([
  'very', 'really', 'so', 'extremely', 'super', 'totally', 'absolutely',
  'insanely', 'hella', 'freaking', 'fricking', 'fucking', 'damn', 'insanely',
  'damn', 'mad', 'unbelievably', 'incredibly', 'fucking', 'truly', 'literally',
]);

const DAMPENERS = new Set([
  'kinda', 'sort', 'sorta', 'slightly', 'somewhat', 'mildly', 'little',
  'barely', 'fairly', 'ish', 'kinda',
]);

const EMOJI = {
  '❤': 2.4, '❤️': 2.4, '🧡': 2.2, '💛': 2.2, '💚': 2.2, '💙': 2.2, '💜': 2.2,
  '🖤': 1.8, '🤍': 1.8, '💖': 2.5, '💕': 2.4, '💞': 2.3, '💘': 2.3, '💝': 2.3,
  '😍': 2.6, '🥰': 2.5, '😘': 2.4, '😊': 2.1, '😁': 2.0, '😄': 2.0, '😃': 1.9,
  '🙂': 1.5, '😌': 1.6, '🤗': 2.1, '👍': 2.0, '👌': 1.8, '🙌': 2.1, '👏': 2.0,
  '🙏': 1.6, '💪': 1.8, '🔥': 2.4, '✨': 1.8, '💯': 2.4, '🎉': 2.4, '🎊': 2.4,
  '🥳': 2.4, '😂': 2.2, '🤣': 2.3, '😆': 2.0, '😹': 2.1, '💀': 1.1, '☠': 0.8,
  '😭': 0.9, '🥲': 0.6, '🫡': 1.2, '🤝': 1.6, '😎': 1.9, '🤩': 2.4, '🍀': 1.6,
  '👑': 1.9, '🏆': 2.2, '⭐': 1.9, '✅': 1.4, '💸': 1.2, '🍕': 1.4, '🎂': 1.6,
  '😞': -2.0, '😔': -2.0, '😟': -1.9, '😢': -2.0, '😥': -1.8, '😰': -2.1,
  '😨': -2.2, '😱': -2.3, '😡': -2.7, '🤬': -3.0, '😠': -2.5, '👎': -2.2,
  '💩': -2.3, '🤮': -2.8, '🤢': -2.4, '😤': -1.0, '🙄': -1.9, '😒': -1.9,
  '😑': -1.2, '💔': -2.4, '🔪': -2.2, '🧠': 0.4, '🫠': -1.0, '😬': -1.4,
  '🗑': -2.2, '🚮': -2.2, '❌': -1.6, '⚠': -1.2, '🤡': -2.0, '🐀': -1.6,
  '😴': -0.6, '🥶': -0.8, '🥵': -0.8, '😣': -1.8, '😖': -1.8, '😩': -1.7,
  '😫': -1.8, '😩': -1.7, '🫥': -1.0, '💀💀': 1.3,
};

const SHORTCODE = {
  fire: 2.4, heart: 2.4, sob: 0.9, skull: 1.1, thumbsup: 2.0, '+1': 2.0,
  '100': 2.4, clap: 2.0, pray: 1.6, joy: 2.2, rofl: 2.2, wave: 1.2, ok_hand: 1.8,
  clown: -2.0, poop: -2.3, thumbsdown: -2.2, rage: -2.6, sob: 0.9, facepalm: -1.5,
  eyes: 0.6, thinking: 0.2, skull_crossbones: 0.8, sparkles: 1.8, crown: 1.9,
  trophy: 2.2, tada: 2.4, partying_face: 2.4, heart_eyes: 2.6, smiling_face: 2.0,
  slightly_smiling_face: 1.2, neutral_face: 0.0, cry: -1.6, angry: -2.5,
  cursing_face: -2.8, trash: -2.2, 'thumbs-up': 2.0, 'thumbs-down': -2.2,
};

const PHRASES = [
  [/\bno\s+cap\b/gi, 'nocap'],
  [/\bworth\s+it\b/gi, 'worthit'],
  [/\b(let'?s|lets)\s+go+\b/gi, 'letsgo'],
  [/\bthank(s| you)\b/gi, 'thanks'],
  [/\bgood\s+job\b/gi, 'goodjob'],
  [/\bwell\s+done\b/gi, 'welldone'],
  [/\bmakes?\s+sense\b/gi, 'makesense'],
  [/\bno\s+worries\b/gi, 'noworries'],
  [/\bgood\s+game\b/gi, 'gg'],
  [/\bwell\s+played\b/gi, 'wp'],
  [/\bf+u+c+k+\b/gi, 'fuck'],
  [/\bl+m+a+o+\b/gi, 'lmao'],
  [/\bl+o+l+\b/gi, 'lol'],
  [/\bh+a+h+a+\b/gi, 'haha'],
];

const EMOJI_RE = /\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu;

function normalizePhrases(text) {
  let out = text;
  for (const [re, rep] of PHRASES) out = out.replace(re, rep);
  return out;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * @param {string} input
 * @returns {{score:number,label:'positive'|'negative'|'neutral',magnitude:number,hits:number}}
 */
export function score(input) {
  const original = String(input ?? '');
  const text = normalizePhrases(original);

  // ---- words -------------------------------------------------------------
  const tokens = [];
  for (const raw of text.split(/\s+/)) {
    const clean = raw
      .replace(/[^\p{L}\p{N}']/gu, '')
      .toLowerCase()
      .replace(/^'+|'+$/g, '');
    if (!clean) continue;
    const up = /^[^a-z]*[A-Z]{2,}/.test(raw) && clean.length > 2;
    tokens.push({ w: clean, up });
  }

  let total = 0;
  let hits = 0;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    let base = LEXICON.get(tok.w);
    if (base === undefined && tok.w.length > 3 && tok.w.endsWith('s')) {
      base = LEXICON.get(tok.w.slice(0, -1));
    }
    if (base === undefined) continue;

    let mult = 1;
    let negated = false;
    for (let j = Math.max(0, i - 3); j < i; j++) {
      const ctx = tokens[j].w;
      if (NEGATORS.has(ctx)) negated = true;
      if (BOOSTERS.has(ctx)) mult *= 1.45;
      if (DAMPENERS.has(ctx)) mult *= 0.6;
    }

    let val = base * mult;
    if (negated) val *= -0.74;
    if (tok.up) val *= 1.25;

    total += val;
    hits++;
  }

  // ---- emoji + discord shortcodes ---------------------------------------
  for (const m of original.matchAll(EMOJI_RE)) {
    const e = m[0];
    if (EMOJI[e] !== undefined) {
      total += EMOJI[e];
      hits++;
    } else if (e.length > 1 && EMOJI[e[0]] !== undefined) {
      total += EMOJI[e[0]] * 0.8;
      hits++;
    }
  }
  for (const m of (original + ' ' + text).matchAll(/:([a-z0-9_+-]{2,32}):/gi)) {
    const name = m[1].toLowerCase();
    if (SHORTCODE[name] !== undefined) {
      total += SHORTCODE[name];
      hits++;
    }
  }

  // ---- punctuation / caps emphasis --------------------------------------
  const bangs = (original.match(/!/g) || []).length;
  if (bangs > 0) total *= 1 + Math.min(bangs, 3) * 0.09;
  const question = (original.match(/\?/g) || []).length;
  if (question > 1) total *= 0.97;

  if (hits === 0) return { score: 0, label: 'neutral', magnitude: 0, hits: 0 };

  const scoreVal = Math.tanh(total / 3.5);
  const rounded = Math.round(scoreVal * 1000) / 1000;
  const label = rounded > 0.12 ? 'positive' : rounded < -0.12 ? 'negative' : 'neutral';

  return {
    score: rounded,
    label,
    magnitude: Math.round(Math.abs(total) * 100) / 100,
    hits,
  };
}

export const lexiconSize = LEXICON.size;

/** True when a word is a feeling/evaluation word rather than a subject. */
export function isEmotionWord(word) {
  const w = String(word || '').toLowerCase();
  if (LEXICON.has(w)) return true;
  if (w.length > 3 && w.endsWith('s') && LEXICON.has(w.slice(0, -1))) return true;
  return false;
}

export default { score, lexiconSize, isEmotionWord };
