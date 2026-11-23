// Reruns a routed order's choice of seller from the public records and nothing else of ours.

const DAY_MS = 86_400_000;
const Z_95 = 1.959963984540054;

// The rule a routed receipt names; a receipt naming another version is not rerun by this one.
export const ROUTING_RULE = {
	version: 1,
	windowDays: 30,
	minCalls: 10,
	minDays: 7,
	minHeldOut: 5,
	maxTries: 3,
} as const;

// What the rule saw, as `plan.routing` on a signed order receipt carries it.
export type RoutingSnapshot = {
	readonly version: number;
	readonly as_of: string;
	readonly ranked: readonly {
		readonly capability_id: string;
		readonly price: string;
		readonly group: string;
		readonly calls: number;
		readonly lower: number;
		readonly median_latency_ms: number | null;
	}[];
	readonly unranked: readonly { readonly capability_id: string; readonly why: string }[];
	readonly refused: readonly string[];
};

// One line of `/v1/market/records`, as much of it as the rule reads.
export type RecordLine = {
	readonly capability_id: string;
	readonly source: string;
	readonly observed_at: string;
	readonly liveness: number | null;
	readonly correctness: number | null;
	readonly latency_ms: number | null;
	readonly corrected: boolean;
};

export type Seen = {
	readonly capabilityId: string;
	readonly observedAt: number;
	readonly passed: boolean;
	readonly heldOut: boolean;
	readonly latencyMs: number | null;
};

export type Seller = {
	readonly capabilityId: string;
	readonly price: string;
	readonly group: string;
};

export type RankedSeller = Seller & {
	readonly calls: number;
	readonly lower: number;
	readonly score: number;
	readonly medianLatencyMs: number | null;
};

export type ShortSeller = { readonly capabilityId: string; readonly why: string };

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

export function wilsonLower(pHat: number, n: number): number {
	if (n <= 0) return 0;
	const p = clamp01(pHat);
	const zz = Z_95 * Z_95;
	const margin = Z_95 * Math.sqrt((p * (1 - p)) / n + zz / (4 * n * n));
	return clamp01((p + zz / (2 * n) - margin) / (1 + zz / n));
}

// Money is a decimal string read as whole millionths, never as a float.
function micro(price: string): bigint {
	if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(price)) throw new Error(`not a price: ${price}`);
	const [whole = '0', fraction = ''] = price.split('.');
	return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? null;
}

// The record's lines read the way the router reads its own rows: a corrected one is left out.
export function seenIn(records: readonly RecordLine[], ids: ReadonlySet<string>): Seen[] {
	return records
		.filter((r) => ids.has(r.capability_id) && !r.corrected)
		.map((r) => ({
			capabilityId: r.capability_id,
			observedAt: Date.parse(r.observed_at),
			passed: (r.liveness ?? 0) >= 1 && (r.correctness === null || r.correctness >= 1),
			heldOut: r.source === 'probe' && r.correctness !== null,
			latencyMs: r.latency_ms,
		}));
}

// The lower bound of the share that passed, per dollar; ties go to the faster, then the id.
export function rankSellers(
	sellers: readonly Seller[],
	seen: readonly Seen[],
	now: number,
): { readonly ranked: RankedSeller[]; readonly short: ShortSeller[] } {
	const since = now - ROUTING_RULE.windowDays * DAY_MS;
	const ranked: RankedSeller[] = [];
	const short: ShortSeller[] = [];
	for (const s of sellers) {
		const mine = seen.filter(
			(e) => e.capabilityId === s.capabilityId && e.observedAt > since && e.observedAt <= now,
		);
		const times = mine.map((e) => e.observedAt);
		const span = times.length === 0 ? 0 : (Math.max(...times) - Math.min(...times)) / DAY_MS;
		const heldOut = mine.filter((e) => e.heldOut).length;
		if (
			mine.length < ROUTING_RULE.minCalls ||
			span < ROUTING_RULE.minDays ||
			heldOut < ROUTING_RULE.minHeldOut
		) {
			const why = `${mine.length} calls over ${span.toFixed(1)} days, ${heldOut} held out`;
			short.push({ capabilityId: s.capabilityId, why });
			continue;
		}
		const lower = wilsonLower(mine.filter((e) => e.passed).length / mine.length, mine.length);
		const price = micro(s.price);
		const latencies = mine.flatMap((e) => (e.latencyMs === null ? [] : [e.latencyMs]));
		ranked.push({
			...s,
			calls: mine.length,
			lower,
			score: price > 0n ? lower / Number(price) : 0,
			medianLatencyMs: median(latencies),
		});
	}
	ranked.sort(
		(a, b) =>
			b.score - a.score ||
			(a.medianLatencyMs ?? Number.POSITIVE_INFINITY) -
				(b.medianLatencyMs ?? Number.POSITIVE_INFINITY) ||
			(a.capabilityId < b.capabilityId ? -1 : a.capabilityId > b.capabilityId ? 1 : 0),
	);
	return { ranked, short };
}

// Best first, then the best of a host not yet tried, so a second try leaves a failing upstream.
export function triesFrom(ranked: readonly RankedSeller[]): RankedSeller[] {
	const order: RankedSeller[] = [];
	const hosts = new Set<string>();
	for (const r of ranked) {
		if (order.length === 0 || !hosts.has(r.group)) {
			order.push(r);
			hosts.add(r.group);
		}
	}
	for (const r of ranked) if (!order.includes(r)) order.push(r);
	return order.slice(0, ROUTING_RULE.maxTries);
}

export type Rerun = { readonly agrees: boolean; readonly lines: readonly string[] };

const mark = (same: boolean) => (same ? 'same' : 'DIFF');

function rerunRanked(routing: RoutingSnapshot, seen: readonly Seen[], asOf: number) {
	const sellers = routing.ranked.map((r) => ({
		capabilityId: r.capability_id,
		price: r.price,
		group: r.group,
	}));
	const { ranked } = rankSellers(sellers, seen, asOf);
	const lines: string[] = [];
	let agrees = true;
	for (const said of routing.ranked) {
		const got = ranked.find((r) => r.capabilityId === said.capability_id);
		const lower = got === undefined ? null : Number(got.lower.toFixed(6));
		const same = got !== undefined && got.calls === said.calls && lower === said.lower;
		agrees &&= same;
		const shown = got === undefined ? 'not ranked' : `${got.calls} calls, lower ${lower}`;
		lines.push(
			`  ${mark(same)}  ${said.capability_id}  receipt ${said.calls} calls, lower ${said.lower}; record ${shown}`,
		);
	}
	return { agrees, lines, first: triesFrom(ranked)[0]?.capabilityId };
}

// A seller short of evidence is checked to be still short, since its price never entered a score.
function rerunShort(routing: RoutingSnapshot, seen: readonly Seen[], asOf: number) {
	const sellers = routing.unranked.map((u) => ({
		capabilityId: u.capability_id,
		price: '1',
		group: u.capability_id,
	}));
	const { short } = rankSellers(sellers, seen, asOf);
	const lines: string[] = [];
	let agrees = true;
	for (const said of routing.unranked) {
		const still = short.find((u) => u.capabilityId === said.capability_id);
		const same = still !== undefined && still.why === said.why;
		agrees &&= same;
		lines.push(
			`  ${mark(same)}  ${said.capability_id}  short: receipt ${said.why}; record ${still?.why ?? 'would rank'}`,
		);
	}
	return { agrees, lines };
}

// Every figure the receipt states is recounted; one that differs fails the rerun.
export function rerunRouting(
	routing: RoutingSnapshot,
	firstTried: string | null,
	records: readonly RecordLine[],
): Rerun {
	if (routing.version !== ROUTING_RULE.version) {
		const why = `routing ${routing.version} is not the rule this reruns (${ROUTING_RULE.version})`;
		return { agrees: false, lines: [why] };
	}
	const asOf = Date.parse(routing.as_of);
	const ids = new Set([
		...routing.ranked.map((r) => r.capability_id),
		...routing.unranked.map((u) => u.capability_id),
	]);
	const seen = seenIn(records, ids);
	const ranked = rerunRanked(routing, seen, asOf);
	const short = rerunShort(routing, seen, asOf);
	const rule = ROUTING_RULE;
	const lines = [
		`routing ${routing.version} as of ${routing.as_of}`,
		`ranked only with ${rule.minCalls} calls over ${rule.minDays} days, ${rule.minHeldOut} held out`,
		...ranked.lines,
		...short.lines,
		...routing.refused.map((why) => `  left out by the routing rule: ${why}`),
	];
	const sameFirst = firstTried === null || ranked.first === firstTried;
	if (firstTried !== null) lines.push(`${mark(sameFirst)}  first seller tried: ${firstTried}`);
	return { agrees: ranked.agrees && short.agrees && sameFirst, lines };
}

type OrderReceipt = {
	readonly plan?: {
		readonly routing?: RoutingSnapshot | null;
		readonly steps?: readonly {
			readonly attempt: number;
			readonly capability: { readonly id: string };
		}[];
	} | null;
};

// The receipt and the records file as of its instant, both read from the public api, then rerun.
export async function explainOrder(
	orderId: string,
	options: { readonly origin?: string; readonly fetch?: typeof fetch } = {},
): Promise<Rerun> {
	const get = options.fetch ?? fetch;
	const origin = options.origin ?? 'https://api.teppi.xyz';
	const receipt = (await (await get(`${origin}/v1/orders/${orderId}`)).json()) as OrderReceipt;
	const routing = receipt.plan?.routing;
	if (routing === undefined || routing === null) {
		const why = `${orderId} names no routing: only a call the record chooses a seller for does`;
		return { agrees: false, lines: [why] };
	}
	const first = receipt.plan?.steps?.find((s) => s.attempt === 1)?.capability.id ?? null;
	const asOf = encodeURIComponent(routing.as_of);
	const body = await (await get(`${origin}/v1/market/records?as_of=${asOf}`)).text();
	const records = body
		.split('\n')
		.filter((l) => l.trim() !== '')
		.map((l) => JSON.parse(l) as RecordLine);
	return rerunRouting(routing, first, records);
}
