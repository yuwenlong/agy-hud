import type { AgyModelQuota, AgyQuotaProbe, AgyQuotaWindow } from '../types.ts';
import { classifyQuotaProvider, isAgyImageModel, type AgyProviderKey } from '../agy-quota.ts';
import { t } from '../i18n/index.ts';
import { sanitizeDisplayText } from '../utils/sanitize.ts';
import type { Frame } from './frame.ts';
import { textWidth, truncateTextToWidth } from './ansi.ts';
import { cyan, dim, getQuotaColor, label as labelColor, remainingQuotaBar, RESET, truncateTwoDecimals, warning } from './colors.ts';
import { formatResetTime, wallClock } from './time.ts';

const FIVE_HOUR_THRESHOLD_MS = 12 * 60 * 60 * 1000;

function formatQuotaPctNum(remainingFraction: number): number {
  return truncateTwoDecimals(remainingFraction * 100);
}

function simplifyModelName(name: string): string {
  const rules: Array<[RegExp, (...m: string[]) => string]> = [
    [/^Gemini ([\d.]+) (Flash|Pro|Argon|Hydrogen) \(([^)]+)\)/, (_, ver, fam, rawTier) => `Gemini ${ver} ${fam}(${rawTier.replace(/\s+thinking$/i, '').trim()})`],
    [/^Claude (\w+) ([\d.]+) \(([^)]+)\)/, (_, fam, ver, rawTier) => `${fam} ${ver}(${rawTier.replace(/\s+thinking$/i, '').trim()})`],
    [/^GPT-OSS (.+?) \(\w+\)/, (_, spec) => `GPT-OSS ${spec}`],
  ];
  for (const [re, replacer] of rules) {
    const m = re.exec(name);
    if (m) return name.replace(re, replacer);
  }
  return name;
}

function compactModelName(displayName: string): string {
  const rules: Array<[RegExp, (...m: string[]) => string]> = [
    [/^Gemini [\d.]+ (Flash|Pro|Argon|Hydrogen).*/i, (_, fam) => fam],
    [/^Claude (\w+) [\d.]+ \((\w+)\)/i, (_, fam) => fam],
    [/^GPT-OSS .*/i, () => 'GPT'],
    [/gemini-.*hydrogen/i, () => 'Hydrogen'],
    [/gemini-.*argon/i, () => 'Argon'],
    [/gemini-.*flash/i, () => 'Flash'],
    [/gemini-.*pro/i, () => 'Pro'],
    [/claude-.*sonnet/i, () => 'Sonnet'],
    [/claude-.*opus/i, () => 'Opus'],
    [/claude-.*haiku/i, () => 'Haiku'],
    [/gpt/i, () => 'GPT'],
  ];
  for (const [re, replacer] of rules) {
    const m = re.exec(displayName);
    if (m) return replacer(...m);
  }
  return displayName.slice(0, 6);
}

function isNonExpired(win: AgyQuotaWindow | undefined, now: number): win is AgyQuotaWindow {
  if (!win) return false;
  if (!win.resetTime) return true;
  const ts = Date.parse(win.resetTime);
  return !Number.isFinite(ts) || ts > now;
}

function pickCriticalWindow(q: AgyModelQuota, now: number): { remainingFraction: number; resetTime: string | null } {
  const five = isNonExpired(q.windows?.fiveHour, now) ? q.windows!.fiveHour! : null;
  const week = isNonExpired(q.windows?.weekly, now) ? q.windows!.weekly! : null;
  if (five && week) return five.remainingFraction <= week.remainingFraction ? five : week;
  if (five) return five;
  if (week) return week;
  const topTs = q.resetTime ? Date.parse(q.resetTime) : Number.NaN;
  const topExpired = Number.isFinite(topTs) && topTs <= now;
  const hadWindows = Boolean(q.windows?.fiveHour || q.windows?.weekly);
  if (topExpired || hadWindows) {
    return { remainingFraction: 1, resetTime: null };
  }
  return { remainingFraction: q.remainingFraction, resetTime: q.resetTime ?? null };
}

function isImageModel(q: AgyModelQuota): boolean {
  return isAgyImageModel(q.id, q.displayName);
}

const TABLE_BUCKET_KEYS: Record<AgyProviderKey, 'Google' | 'Claude' | 'Argon'> = {
  google: 'Google',
  claude: 'Claude',
  argon: 'Argon',
};

function truncateAndPad(str: string, width: number, unicode: boolean): string {
  if (width <= 0) return '';
  const ellipsis = unicode ? '…' : '...';
  const truncated = truncateTextToWidth(str, width, ellipsis);
  const pad = Math.max(0, width - textWidth(truncated));
  return `${truncated}${' '.repeat(pad)}`;
}

function formatShortReset(f: Frame, resetTime: string | null | undefined): string {
  if (!resetTime) return '';
  const ts = Date.parse(resetTime);
  if (!Number.isFinite(ts) || ts <= f.now) return '';
  const dur = formatResetTime(new Date(ts), 'relative', wallClock(f.config.display), f.now).replace(/\s+/g, '');
  return dur ? `~${dur}` : '';
}

function ruleBar(f: Frame, targetChars: number): string {
  const maxChars = f.width !== null ? Math.max(12, f.width - 2) : targetChars;
  const count = Math.min(targetChars, maxChars);
  return dim((f.unicode ? '─' : '-').repeat(count));
}

interface QuotaItemOptions {
  barWidth?: number;
  padTime?: boolean;
}

function renderQuotaItem(
  f: Frame,
  name: string,
  remainingFraction: number,
  resetTime: string | null | undefined,
  nameWidth: number,
  options: QuotaItemOptions = {},
): string {
  const { barWidth = 6, padTime = true } = options;
  const colors = f.config.colors;
  const remainingPct = formatQuotaPctNum(remainingFraction);
  const usedPct = 100 - remainingPct;
  const color = getQuotaColor(usedPct, colors, null);
  const namePart = cyan(truncateAndPad(sanitizeDisplayText(name), nameWidth, f.unicode));
  const bar = remainingQuotaBar(remainingPct, usedPct, barWidth, colors, null, f.unicode);
  const pctStr = `${remainingPct.toFixed(2)}%`.padStart(7, ' ');
  const rawTime = formatShortReset(f, resetTime);
  const timeStr = padTime ? rawTime.padEnd(9, ' ') : rawTime;
  return timeStr
    ? `${namePart} ${bar} ${color}${pctStr}${RESET} ${dim(timeStr)}`
    : `${namePart} ${bar} ${color}${pctStr}${RESET}`;
}

function renderProviderTable(f: Frame, probe: AgyQuotaProbe): string[] {
  const now = f.now;
  const buckets: Record<'Google' | 'Claude' | 'Argon', { fiveHour: AgyQuotaWindow | null; weekly: AgyQuotaWindow | null }> = {
    Google: { fiveHour: null, weekly: null },
    Claude: { fiveHour: null, weekly: null },
    Argon: { fiveHour: null, weekly: null },
  };

  for (const q of probe.models) {
    if (!q || isImageModel(q)) continue;
    const providerKey = classifyQuotaProvider(q.id, q.displayName, q.modelProvider);
    const key = providerKey ? TABLE_BUCKET_KEYS[providerKey] : null;
    if (!key) continue;

    if (isNonExpired(q.windows?.fiveHour, now)) {
      const cur = buckets[key].fiveHour;
      const w = q.windows!.fiveHour!;
      if (!cur || (w.observedAt ?? 0) > (cur.observedAt ?? 0) || ((w.observedAt ?? 0) === (cur.observedAt ?? 0) && w.remainingFraction < cur.remainingFraction)) {
        buckets[key].fiveHour = w;
      }
    }
    if (isNonExpired(q.windows?.weekly, now)) {
      const cur = buckets[key].weekly;
      const w = q.windows!.weekly!;
      if (!cur || (w.observedAt ?? 0) > (cur.observedAt ?? 0) || ((w.observedAt ?? 0) === (cur.observedAt ?? 0) && w.remainingFraction < cur.remainingFraction)) {
        buckets[key].weekly = w;
      }
    }
    if (q.resetTime && !q.windows?.fiveHour && !q.windows?.weekly) {
      const ms = Date.parse(q.resetTime) - now;
      if (Number.isFinite(ms) && ms > 0) {
        const winKey = ms < FIVE_HOUR_THRESHOLD_MS ? 'fiveHour' : 'weekly';
        const cur = buckets[key][winKey];
        if (!cur || q.remainingFraction < cur.remainingFraction) {
          buckets[key][winKey] = { remainingFraction: q.remainingFraction, resetTime: q.resetTime };
        }
      }
    }
  }

  const pq = probe.providerQuota;
  if (pq) {
    if (isNonExpired(pq.google?.fiveHour, now)) buckets.Google.fiveHour = pq.google!.fiveHour!;
    if (isNonExpired(pq.google?.weekly, now)) buckets.Google.weekly = pq.google!.weekly!;
    if (isNonExpired(pq.claude?.fiveHour, now)) buckets.Claude.fiveHour = pq.claude!.fiveHour!;
    if (isNonExpired(pq.claude?.weekly, now)) buckets.Claude.weekly = pq.claude!.weekly!;
    if (isNonExpired(pq.argon?.fiveHour, now)) buckets.Argon.fiveHour = pq.argon!.fiveHour!;
    if (isNonExpired(pq.argon?.weekly, now)) buckets.Argon.weekly = pq.argon!.weekly!;
  }

  let nameWidth = 11;
  let barWidth = 6;
  let twoColumn = true;
  if (f.width !== null && f.width < 77) {
    if (f.width >= 75) {
      barWidth = 5;
    } else if (f.width >= 73) {
      barWidth = 4;
    } else if (f.width >= 71) {
      barWidth = 3;
    } else if (f.width >= 65) {
      barWidth = 3;
      nameWidth = Math.floor((f.width - 49) / 2);
    } else {
      twoColumn = false;
      barWidth = f.width >= 38 ? 6 : 4;
      nameWidth = Math.max(6, Math.min(11, f.width - barWidth - 21));
    }
  }

  const vbar = f.unicode ? '│' : '|';
  const item = (lbl: string, w: AgyQuotaWindow | null, padTime: boolean) =>
    renderQuotaItem(f, lbl, w?.remainingFraction ?? 1, w?.resetTime ?? null, nameWidth, { barWidth, padTime });

  const pairs: Array<[string, AgyQuotaWindow | null, string, AgyQuotaWindow | null]> = [
    ['Google 5h', buckets.Google.fiveHour, 'Claude 5h', buckets.Claude.fiveHour],
    ['Google week', buckets.Google.weekly, 'Claude week', buckets.Claude.weekly],
  ];

  const rows: string[] = [`  ${ruleBar(f, twoColumn ? 77 : nameWidth + barWidth + 19)}`];
  if (twoColumn) {
    for (const [lLabel, lWin, rLabel, rWin] of pairs) {
      rows.push(`  ${item(lLabel, lWin, true)} ${dim(vbar)} ${item(rLabel, rWin, false)}`);
    }
    if (buckets.Argon.fiveHour || buckets.Argon.weekly) {
      if (buckets.Argon.fiveHour && buckets.Argon.weekly) {
        rows.push(`  ${item('Argon 5h', buckets.Argon.fiveHour, true)} ${dim(vbar)} ${item('Argon week', buckets.Argon.weekly, false)}`);
      } else if (buckets.Argon.fiveHour) {
        rows.push(`  ${item('Argon 5h', buckets.Argon.fiveHour, false)}`);
      } else {
        rows.push(`  ${item('Argon week', buckets.Argon.weekly, false)}`);
      }
    }
  } else {
    const singleItems: Array<[string, AgyQuotaWindow | null]> = [
      ['Google 5h', buckets.Google.fiveHour],
      ['Google week', buckets.Google.weekly],
      ['Claude 5h', buckets.Claude.fiveHour],
      ['Claude week', buckets.Claude.weekly],
    ];
    if (buckets.Argon.fiveHour) singleItems.push(['Argon 5h', buckets.Argon.fiveHour]);
    if (buckets.Argon.weekly) singleItems.push(['Argon week', buckets.Argon.weekly]);
    for (const [lbl, w] of singleItems) {
      rows.push(`  ${item(lbl, w, false)}`);
    }
  }
  return rows;
}

function renderModelsTable(f: Frame, probe: AgyQuotaProbe): string[] {
  const models = probe.models.filter((q) => !isImageModel(q));
  if (models.length === 0) return [];
  const columnWidth = f.config.display?.columnWidth ?? 40;
  const twoColumn = models.length > 1 && (f.width === null || f.width >= 71);
  let nameWidth = Math.max(8, columnWidth - 24);
  if (f.width !== null) {
    const maxNameWidth = twoColumn ? Math.floor((f.width - 55) / 2) : f.width - 27;
    nameWidth = Math.max(8, Math.min(nameWidth, maxNameWidth));
  }
  const renderModel = (q: AgyModelQuota, padTime: boolean) => {
    const crit = pickCriticalWindow(q, f.now);
    return renderQuotaItem(f, simplifyModelName(q.displayName || q.id), crit.remainingFraction, crit.resetTime, nameWidth, { padTime });
  };
  const vbar = f.unicode ? '│' : '|';
  const targetRuleWidth = twoColumn ? 2 * nameWidth + 53 : nameWidth + 25;
  const rule = ruleBar(f, targetRuleWidth);
  const rows: string[] = [`  ${rule}`];
  if (twoColumn) {
    for (let i = 0; i < models.length; i += 2) {
      const hasRight = Boolean(models[i + 1]);
      const left = renderModel(models[i], hasRight);
      rows.push(hasRight ? `  ${left} ${dim(vbar)} ${renderModel(models[i + 1], false)}` : `  ${left}`);
    }
  } else {
    for (const q of models) {
      rows.push(`  ${renderModel(q, false)}`);
    }
  }
  rows.push(`  ${rule}`);
  return rows;
}

function renderCompactBars(f: Frame, probe: AgyQuotaProbe): string[] {
  const providerLabels: Record<string, string> = {
    MODEL_PROVIDER_GOOGLE: 'Google',
    MODEL_PROVIDER_ANTHROPIC: 'Anthropic',
    MODEL_PROVIDER_OPENAI: 'OpenAI',
  };
  const groups = new Map<string, AgyModelQuota[]>();
  for (const q of probe.models) {
    if (!q || isImageModel(q)) continue;
    const pLabel = providerLabels[q.modelProvider ?? ''] ?? 'Other';
    if (!groups.has(pLabel)) groups.set(pLabel, []);
    groups.get(pLabel)!.push(q);
  }
  const segments: string[] = [];
  for (const [provider, models] of groups) {
    const familyMap = new Map<string, { name: string; remainingFraction: number }>();
    for (const q of models) {
      const key = compactModelName(q.displayName || q.id);
      const crit = pickCriticalWindow(q, f.now);
      const existing = familyMap.get(key);
      if (!existing || crit.remainingFraction < existing.remainingFraction) {
        familyMap.set(key, { name: key, remainingFraction: crit.remainingFraction });
      }
    }
    const items = [...familyMap.values()].map(({ name, remainingFraction }) => {
      const pct = formatQuotaPctNum(remainingFraction);
      const bar = remainingQuotaBar(pct, 100 - pct, 3, f.config.colors, null, f.unicode);
      return `${cyan(sanitizeDisplayText(name))}${bar}`;
    });
    segments.push(`${labelColor(`${provider}:`, f.config.colors)} ${items.join(' ')}`);
  }
  return segments.length > 0 ? [segments.join(f.sep)] : [];
}

export function agyQuotaExtraLines(f: Frame): string[] {
  const style = f.config.display?.quotaStyle ?? 'minimal';
  if (f.config.display?.showUsage === false || style === 'minimal') return [];
  const probe = f.agyQuota;
  if (!probe) return [];

  if (probe.models.length > 0 || probe.providerQuota) {
    if (style === 'compact') return renderCompactBars(f, probe);
    if (style === 'models') return renderModelsTable(f, probe);
    return renderProviderTable(f, probe);
  }

  const rule = ruleBar(f, (f.config.display?.columnWidth ?? 40) * 2 + 1);
  if (probe.unavailableReason) {
    const reasonKeyMap: Record<string, string> = {
      not_logged_in: t('quota.notLoggedIn'),
      expired_token: t('quota.expiredToken'),
      auth_failed: t('quota.authFailed'),
      quota_fetch_failed: t('quota.fetchFailed'),
    };
    const reason = reasonKeyMap[probe.unavailableReason] ?? sanitizeDisplayText(probe.unavailableReason);
    return [`  ${rule}`, `  ${warning(`${t('quota.unavailable')}:`, f.config.colors)} ${dim(reason)}`, `  ${rule}`];
  }
  const ellipsis = f.unicode ? '…' : '...';
  return [`  ${rule}`, `  ${dim(`${t('quota.loading')}${ellipsis}`)}`, `  ${rule}`];
}
