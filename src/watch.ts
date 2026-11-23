// Remembers who an agent paid and says when one of them lands on, or leaves, the refusal list.

export type PayeeChange = {
	readonly payee: string;
	readonly listed: boolean;
	// Why it was listed: kept money for nothing, or mostly wrong answers.
	readonly why: readonly string[];
	readonly evidence: readonly string[];
};

export type PayeeWatch = {
	readonly add: (payee: string) => void;
	readonly check: () => Promise<PayeeChange[]>;
	readonly stop: () => void;
	readonly payees: () => readonly string[];
};

export type PayeeWatchOptions = {
	readonly onChange?: (change: PayeeChange) => void;
	// 0 turns the timer off, for a caller that runs check() itself.
	readonly intervalMs?: number;
	readonly origin?: string;
	readonly fetchImpl?: typeof fetch;
	readonly userAgent?: string;
};

// The list moves a few times a day, so checking more often only costs requests.
export const WATCH_INTERVAL_MS = 15 * 60_000;

type Entry = { payout: string; why?: string[]; evidence?: string[] };

const key = (address: string) => address.toLowerCase();

export function payeeWatch(options: PayeeWatchOptions = {}): PayeeWatch {
	// Keyed in lower case to match the list, reported as given, since base58 is case sensitive.
	const listed = new Map<string, { address: string; listed: boolean }>();
	const origin = options.origin ?? 'https://api.teppi.xyz';
	let timer: ReturnType<typeof setInterval> | null = null;

	const check = async (): Promise<PayeeChange[]> => {
		if (listed.size === 0) return [];
		const response = await (options.fetchImpl ?? fetch)(`${origin}/v1/policy/payouts`, {
			headers: { 'user-agent': options.userAgent ?? 'teppi-client' },
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) throw new Error(`the payout list answered ${response.status}`);
		const body = (await response.json()) as { entries?: Entry[] };
		const byPayout = new Map((body.entries ?? []).map((e) => [key(e.payout), e]));
		const changes: PayeeChange[] = [];
		for (const [k, state] of listed) {
			const entry = byPayout.get(k);
			const now = entry !== undefined;
			if (now === state.listed) continue;
			state.listed = now;
			const change = {
				payee: state.address,
				listed: now,
				why: entry?.why ?? [],
				evidence: entry?.evidence ?? [],
			};
			changes.push(change);
			options.onChange?.(change);
		}
		return changes;
	};

	const interval = options.intervalMs ?? WATCH_INTERVAL_MS;
	const start = () => {
		if (timer !== null || interval <= 0) return;
		// A failed read is retried at the next tick; it must never crash the agent.
		timer = setInterval(() => void check().catch(() => {}), interval);
		// Don't keep a process alive just to watch.
		(timer as { unref?: () => void }).unref?.();
	};

	return {
		add: (payee) => {
			if (!listed.has(key(payee))) listed.set(key(payee), { address: payee, listed: false });
			start();
		},
		check,
		stop: () => {
			if (timer !== null) clearInterval(timer);
			timer = null;
		},
		payees: () => [...listed.values()].map((s) => s.address),
	};
}
