///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ThemeToggle — the six-hour light or dark theme preference control in a page's navigation bar
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Which of the two themes a page is displayed in. */
export type Theme = 'light' | 'dark';

/** A theme the reader chose by hand, and the moment that choice stops applying. */
type StoredThemePreference = {
	theme: Theme;
	expiresAt: number;
};

/** Where the chosen theme is kept in the browser's local storage. */
const themeStorageKey = 'webai-theme-preference';

/** How long a theme chosen by hand applies before the page follows the system again. */
const themePreferenceDurationMs = 6 * 60 * 60 * 1000;

/**
 * Applies the reader's theme and keeps the button that switches it up to date.
 *
 * A theme chosen by hand wins for six hours and is remembered in local storage. Outside
 * that window the page follows the system setting, and changes to the system setting take
 * effect immediately while no choice by hand is in force.
 */
export class ThemeToggle {
	/**
	 * Adds the theme preference control to a page's navigation bar.
	 *
	 * @param selector The button to turn into the theme control.
	 * @throws If no button matches the selector.
	 */
	static setup(selector = '#theme-toggle'): void {
		const button: Element | null = document.querySelector(selector);
		if ((button instanceof HTMLButtonElement) === false) {
			throw new Error(`Theme button ${selector} was not found`);
		}

		const storedPreference: StoredThemePreference | undefined = ThemeToggle.readStoredPreference();
		let theme: Theme = storedPreference?.theme ?? ThemeToggle.systemTheme();
		let preferenceExpiryTimer: number | undefined;
		const useSystemTheme = (): void => {
			if (ThemeToggle.readStoredPreference() !== undefined) {
				return;
			}
			theme = ThemeToggle.systemTheme();
			ThemeToggle.applyTheme(theme);
			ThemeToggle.updateButton(button, theme);
		};
		const schedulePreferenceExpiry = (expiresAt: number): void => {
			if (preferenceExpiryTimer !== undefined) {
				window.clearTimeout(preferenceExpiryTimer);
			}
			preferenceExpiryTimer = window.setTimeout(useSystemTheme, Math.max(0, expiresAt - Date.now()));
		};
		if (storedPreference !== undefined) {
			schedulePreferenceExpiry(storedPreference.expiresAt);
		}
		ThemeToggle.applyTheme(theme);
		ThemeToggle.updateButton(button, theme);
		button.addEventListener('click', (): void => {
			theme = theme === 'dark' ? 'light' : 'dark';
			const preference: StoredThemePreference = {
				theme,
				expiresAt: Date.now() + themePreferenceDurationMs,
			};
			try {
				window.localStorage.setItem(themeStorageKey, JSON.stringify(preference));
			} catch {
				// The selected theme still applies for this page when storage is unavailable.
			}
			schedulePreferenceExpiry(preference.expiresAt);
			ThemeToggle.applyTheme(theme);
			ThemeToggle.updateButton(button, theme);
		});

		const mediaQuery: MediaQueryList = ThemeToggle.systemThemeMediaQuery();
		mediaQuery.addEventListener('change', useSystemTheme);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/** Returns the media query that reports the system's own light or dark setting. */
	private static systemThemeMediaQuery(): MediaQueryList {
		return window.matchMedia('(prefers-color-scheme: dark)');
	}

	/** Returns the theme the system is currently set to. */
	private static systemTheme(): Theme {
		return ThemeToggle.systemThemeMediaQuery().matches ? 'dark' : 'light';
	}

	/**
	 * Reads the theme chosen by hand from local storage.
	 *
	 * @returns The stored choice, or `undefined` when there is none, when it has expired, or
	 * when local storage cannot be read at all.
	 */
	private static readStoredPreference(): StoredThemePreference | undefined {
		try {
			const storedValue: string | null = window.localStorage.getItem(themeStorageKey);
			if (storedValue === null) {
				return undefined;
			}
			const preference: unknown = JSON.parse(storedValue);
			if (typeof preference !== 'object' || preference === null) {
				return undefined;
			}
			const { theme, expiresAt } = preference as Partial<StoredThemePreference>;
			if ((theme !== 'light' && theme !== 'dark') || typeof expiresAt !== 'number' || expiresAt <= Date.now()) {
				window.localStorage.removeItem(themeStorageKey);
				return undefined;
			}
			return {
				theme,
				expiresAt,
			};
		} catch {
			return undefined;
		}
	}

	/**
	 * Puts a theme into effect on the page.
	 *
	 * @param theme The theme to display the page in.
	 */
	private static applyTheme(theme: Theme): void {
		const root: HTMLElement = document.documentElement;
		root.dataset.theme = theme;
		root.dataset.bsTheme = theme;
		root.style.colorScheme = theme;
	}

	/**
	 * Relabels the control to name the theme it would switch to.
	 *
	 * @param button The theme control.
	 * @param theme The theme currently in effect.
	 */
	private static updateButton(button: HTMLButtonElement, theme: Theme): void {
		const nextTheme: Theme = theme === 'dark' ? 'light' : 'dark';
		const iconName: string = nextTheme === 'dark' ? 'moon-stars-fill' : 'sun-fill';
		button.innerHTML = `<i class="bi bi-${iconName} me-1" aria-hidden="true"></i>Use ${nextTheme} theme`;
		button.setAttribute('aria-label', `Use ${nextTheme} theme`);
		button.setAttribute('title', `Use ${nextTheme} theme`);
	}
}
