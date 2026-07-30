export type Theme = "light" | "dark";

type StoredThemePreference = {
	theme: Theme;
	expiresAt: number;
};

const themeStorageKey = "webai-theme-preference";
const themePreferenceDurationMs = 6 * 60 * 60 * 1000;

const systemThemeMediaQuery = (): MediaQueryList => window.matchMedia("(prefers-color-scheme: dark)");
const systemTheme = (): Theme => systemThemeMediaQuery().matches ? "dark" : "light";

const readStoredThemePreference = (): StoredThemePreference | undefined => {
	try {
		const storedValue: string | null = window.localStorage.getItem(themeStorageKey);
		if (storedValue === null) return undefined;
		const preference: unknown = JSON.parse(storedValue);
		if (typeof preference !== "object" || preference === null) return undefined;
		const { theme, expiresAt } = preference as Partial<StoredThemePreference>;
		if ((theme !== "light" && theme !== "dark") || typeof expiresAt !== "number" || expiresAt <= Date.now()) {
			window.localStorage.removeItem(themeStorageKey);
			return undefined;
		}
		return { theme, expiresAt };
	} catch {
		return undefined;
	}
};

const activeTheme = (): Theme => readStoredThemePreference()?.theme ?? systemTheme();

const applyTheme = (theme: Theme): void => {
	const root: HTMLElement = document.documentElement;
	root.dataset.theme = theme;
	root.dataset.bsTheme = theme;
	root.style.colorScheme = theme;
};

const updateThemeButton = (button: HTMLButtonElement, theme: Theme): void => {
	const nextTheme: Theme = theme === "dark" ? "light" : "dark";
	const iconName: string = nextTheme === "dark" ? "moon-stars-fill" : "sun-fill";
	button.innerHTML = `<i class="bi bi-${iconName} me-1" aria-hidden="true"></i>Use ${nextTheme} theme`;
	button.setAttribute("aria-label", `Use ${nextTheme} theme`);
	button.setAttribute("title", `Use ${nextTheme} theme`);
};

/** Adds the six-hour theme preference control to a page's navigation bar. */
export const setupThemeToggle = (selector = "#theme-toggle"): void => {
	const button: Element | null = document.querySelector(selector);
	if (!(button instanceof HTMLButtonElement)) throw new Error(`Theme button ${selector} was not found`);

	const storedPreference: StoredThemePreference | undefined = readStoredThemePreference();
	let theme: Theme = storedPreference?.theme ?? systemTheme();
	let preferenceExpiryTimer: number | undefined;
	const useSystemTheme = (): void => {
		if (readStoredThemePreference() !== undefined) return;
		theme = systemTheme();
		applyTheme(theme);
		updateThemeButton(button, theme);
	};
	const schedulePreferenceExpiry = (expiresAt: number): void => {
		if (preferenceExpiryTimer !== undefined) window.clearTimeout(preferenceExpiryTimer);
		preferenceExpiryTimer = window.setTimeout(useSystemTheme, Math.max(0, expiresAt - Date.now()));
	};
	if (storedPreference !== undefined) schedulePreferenceExpiry(storedPreference.expiresAt);
	applyTheme(theme);
	updateThemeButton(button, theme);
	button.addEventListener("click", (): void => {
		theme = theme === "dark" ? "light" : "dark";
		const preference: StoredThemePreference = { theme, expiresAt: Date.now() + themePreferenceDurationMs };
		try {
			window.localStorage.setItem(themeStorageKey, JSON.stringify(preference));
		} catch {
			// The selected theme still applies for this page when storage is unavailable.
		}
		schedulePreferenceExpiry(preference.expiresAt);
		applyTheme(theme);
		updateThemeButton(button, theme);
	});

	const mediaQuery: MediaQueryList = systemThemeMediaQuery();
	mediaQuery.addEventListener("change", useSystemTheme);
};
