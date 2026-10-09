export function hostMatches(pattern: string, hostname: string): boolean;
export function pickProfile<P extends { id: string; hosts?: string[]; default?: boolean }>(profiles: P[], hostname: string, override?: string | null): P;
