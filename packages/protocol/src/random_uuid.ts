///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	RandomUuid — generates a version 4 universally unique identifier in every context
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Generates a version 4 universally unique identifier, in a browser as well as in Node.js.
 *
 * A browser only offers `crypto.randomUUID` to a page in a secure context, which means a page
 * served over HTTPS or served from `localhost`. A page served over plain HTTP from any other
 * address, such as `http://135.125.8.186:8787`, is not in a secure context, so
 * `crypto.randomUUID` is missing there and calling it fails with "crypto.randomUUID is not a
 * function". `crypto.getRandomValues` carries no such restriction, so this class falls back to
 * assembling the identifier from the random bytes that call returns.
 */
export class RandomUuid {
	/**
	 * Generates one version 4 universally unique identifier.
	 *
	 * @returns The identifier written in the usual 8-4-4-4-12 lowercase hexadecimal form.
	 */
	static generate(): string {
		if (typeof crypto.randomUUID === 'function') {
			return crypto.randomUUID();
		}

		const bytes = new Uint8Array(16);
		crypto.getRandomValues(bytes);
		// The two fields that mark a version 4 identifier: the version number 4 in the high half
		// of byte 6, and the variant bits `10` in the two high bits of byte 8.
		bytes[6] = (bytes[6] & 0x0f) | 0x40;
		bytes[8] = (bytes[8] & 0x3f) | 0x80;

		const hexadecimal = Array.from(bytes, (byteValue: number): string => byteValue.toString(16).padStart(2, '0')).join('');
		return [
			hexadecimal.slice(0, 8),
			hexadecimal.slice(8, 12),
			hexadecimal.slice(12, 16),
			hexadecimal.slice(16, 20),
			hexadecimal.slice(20, 32),
		].join('-');
	}
}
