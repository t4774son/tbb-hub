// The scam filter: instant, rule-based, no AI. It acts ONLY on scams, drainers and
// seed-phrase phishing, impersonation of staff, pushing people off-site ("DM me", "message me on telegram"), flooding and
// repeats. Swearing, insults, strong opinions and ALL CAPS are none of its business.
// Outcome: allow (post it) · hold (store hidden, admin's queue, never broadcast) · reject (refuse with a message).
import { isStaffName } from './rules.js';

const ASK = String.raw`(?:send|share|give|dm|paste|enter|type|verify|confirm|import|submit|provide|show|tell|drop|post|ask(?:ing)?|connect|link|sync|validate|claim|collect|redeem|trust|click|open)`;
const NEG = String.raw`(?:never|don'?t|do not|nobody|no one|no-one|not|won'?t|shouldn'?t|wouldn'?t|cannot|can'?t|nobody will|stop)`;
const SECRET_WORDS = String.raw`(?:seed|secret|recovery|backup|mnemonic|12|24)[\s-]*(?:phrase|words?)|private[\s-]*keys?|keystore|json keys?`;
const OFFSITE_APPS = String.raw`(?:telegram|tg|whatsapp|whats app|signal|discord|insta(?:gram)?|snap(?:chat)?|wechat|viber|messenger|x dms?|twitter dms?|dms?)`;

// [label, weight, pattern]. 4 = refused on its own; 2 = held for the admin; 1 = only adds up.
export const SIGNALS = [
  ['seed_ask', 4, new RegExp(String.raw`\b${ASK}\b[^!?\n]{0,40}\b(?:${SECRET_WORDS})\b|\b(?:${SECRET_WORDS})\b[^!?\n]{0,30}\b(?:here|below|to me|to us|in dm|via dm|now)\b`, 'i')],
  ['connect_wallet', 4, /\b(?:connect|link|sync|validate|verify|authenticate|re-?authorize|unlock|restore|rectify|resolve)\b[^!?\n]{0,25}\b(?:your |ur |the )?wallets?\b/i],
  ['claim_airdrop', 4, /\b(?:claim|collect|redeem|receive|grab)\b[^!?\n]{0,25}\b(?:airdrop|rewards?|tokens?|prize|bonus|allocation|free (?:sol|tbb|btc|eth|nft))\b/i],
  ['double_your', 4, /\b(?:double|triple|2x|3x|10x|100x)\b[^!?\n]{0,12}\b(?:your|ur|any|every)\b[^!?\n]{0,12}\b(?:sol|tbb|btc|eth|crypto|coins?|tokens?|money|funds|deposit|investment)\b|\bsend\b[^!?\n]{0,20}\b(?:get|receive)\b[^!?\n]{0,20}\bback\b/i],
  ['send_me', 4, /\b(?:send|transfer|deposit)\b[^!?\n]{0,12}\b(?:me|us|here|to this|to my|to the)\b[^!?\n]{0,25}\b(?:sol|tbb|btc|eth|usdc|usdt|crypto|coins?|tokens?|funds|money|fee|gas)\b/i],
  ['whitelist', 4, /\b(?:whitelist|white-?list|allowlist|presale|pre-sale|private sale|early access|guaranteed)\b[^!?\n]{0,25}\b(?:mint|spots?|slots?|open|now|dm|link|list)\b/i],
  ['dm_me', 4, new RegExp(String.raw`\b(?:dm|pm|inbox|message|msg|text|hit|ping|write|contact|reach)\s+(?:me|us)\b|\b(?:message|msg|text|contact|reach|find|add|hit)\s+(?:me|us)?\s*(?:up\s+)?on\s+${OFFSITE_APPS}\b|\b(?:on|via|in)\s+(?:tg|telegram|whatsapp|signal|discord)\b[^!?\n]{0,20}@\w+|@\w+\s+on\s+${OFFSITE_APPS}\b|\b(?:my|our)\s+${OFFSITE_APPS}\b[^!?\n]{0,6}(?:is|:)|\bjoin\b[^!?\n]{0,20}\b(?:group|channel|server)\b`, 'i')],
  ['staff_claim', 4, /\b(?:i am|i'm|im|this is|we are|we're)\s+(?:an?\s+|the\s+|from\s+)?(?:official\s+)?(?:admin|administrator|mod|moderator|support|staff|team member|dev|developer|owner|founder|community manager|cm)\b|\badmin\s+here\b|\b(?:official|customer|tbb|wallet)\s+support\b|\bsupport\s+(?:team|agent|desk|ticket|portal)\b/i],
  ['urgency_scam', 2, /\b(?:urgent|urgently|hurry|act now|last chance|limited time|expires? (?:in|today|soon)|only \d+ (?:spots|left)|before it'?s too late|asap)\b/i],
  ['giveaway', 2, /\b(?:giveaway|give away|free (?:sol|tbb|btc|eth|money|tokens|coins|mint|airdrop)|winners? (?:announced|selected|chosen)|you (?:have )?(?:won|been selected|are eligible))\b/i],
  ['offsite_app', 2, new RegExp(String.raw`\b(?:telegram|whatsapp|signal app|wechat|viber)\b|\btg\s+(?:group|channel|chat)\b|\bdiscord\s+(?:server|invite|link)\b`, 'i')],
  ['secret_words', 1, new RegExp(String.raw`\b(?:${SECRET_WORDS})\b`, 'i')],
  ['airdrop', 1, /\b(?:airdrops?|whitelist|presale)\b/i],
  ['verify', 1, /\b(?:verify|verification|validate|validation|kyc|authenticate|rectify|sync)\b/i],
  ['claim', 1, /\b(?:claim|reward|bonus|eligible|allocation)\b/i],
  ['support', 1, /\b(?:support|helpdesk|help desk|ticket|customer service|live chat)\b/i],
  ['mass_mentions', 2, /(?:@\w+[\s,]+){3,}@\w+/],
];
// "never share your seed phrase" is good advice, not a phish: a negation within a few words of the asking verb cancels seed_ask.
const NEGATED_ASK = new RegExp(String.raw`\b${NEG}\b\W+(?:\w+\W+){0,3}\b${ASK}\b|\b${NEG}\b\W+(?:\w+\W+){0,4}\b(?:${SECRET_WORDS})\b|\b(?:${SECRET_WORDS})\b[^!?\n]{0,30}\b(?:scam|phish|drainer|stolen|steal)`, 'i');

export const HOLD_MSG = 'Your message is waiting for a moderator to look at it.';
export const REJECT_MSG = 'That message looks like a scam pattern (asking for wallet access, keys or payment, or moving people off-site), so it wasn’t posted.';
export const REPEAT_MSG = 'You just said that.';
export const FLOOD_MSG = 'Slow down a little.';
export const NAME_MSG = 'That display name looks like staff. Pick a different one before posting.';

const squash = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();

// text: the message; name: the author's display name; recent: the author's recent messages [{ body, at }], newest last.
export function scoreMessage(text, { name = '', recent = [], now = Date.now() } = {}) {
  const t = String(text).replace(/[\u2018\u2019\u0060\u00b4]/g, "'");
  const reasons = []; let score = 0;
  if (recent.filter((m) => now - m.at < 60_000).length >= 5) return { outcome: 'reject', kind: 'flood', score: 99, reasons: ['flood'], error: FLOOD_MSG };
  const same = squash(t);
  if (recent.some((m) => now - m.at < 10 * 60_000 && squash(m.body) === same)) return { outcome: 'reject', kind: 'repeat', score: 99, reasons: ['repeat'], error: REPEAT_MSG };
  if (name && isStaffName(name)) return { outcome: 'reject', kind: 'impersonation', score: 99, reasons: ['staff_name'], error: NAME_MSG };
  const negated = NEGATED_ASK.test(t);
  for (const [label, weight, re] of SIGNALS) {
    if (!re.test(t)) continue;
    if (negated && ['seed_ask', 'connect_wallet', 'claim_airdrop'].includes(label)) continue;
    reasons.push(label); score += weight;
  }
  // a warning about scams is not a scam: "never share your seed phrase", "don't trust anyone asking you to connect your wallet"
  if (negated && score < 4) { score = Math.max(0, score - 2); }
  const outcome = score >= 4 ? 'reject' : score >= 2 ? 'hold' : 'allow';
  return { outcome, kind: outcome === 'allow' ? null : 'scam', score, reasons, error: outcome === 'reject' ? REJECT_MSG : outcome === 'hold' ? HOLD_MSG : null };
}
