import type { Device, DeviceRole, StageName } from '@webai/protocol';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Dashboard — summarises connected devices and their stage capabilities for the monitor page
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** How often one stage is advertised, as a share of every advertised stage capability. */
export type StageStatistic = {
	stageName: StageName;
	count: number;
	percentage: number;
};

/** The connected devices of each role. */
export type DashboardDevices = Record<DeviceRole, Device[]>;

/**
 * How many characters of a device identifier are appended to a display name that two or more
 * connected devices share. The identifier is a randomly generated universally unique identifier
 * behind its `device-` prefix, so its first characters are already enough to tell two connected
 * devices apart on screen.
 */
const sharedNameSuffixLength = 8;

/** The prefix every device identifier the gateway creates starts with. */
const deviceIdentifierPrefix = 'device-';

/**
 * Turns the gateway's raw device list into the summaries the monitor page displays.
 *
 * Every calculation is here rather than on the page itself, so the same numbers and the same
 * labels can be checked by the gateway's own tests without a browser.
 */
export class Dashboard {
	/**
	 * Groups connected devices by their role.
	 *
	 * @param devices Every device currently connected.
	 * @returns The worker devices and the consumer devices, each in its own list.
	 */
	static splitDevices(devices: Device[]): DashboardDevices {
		return {
			worker: devices.filter((device) => device.deviceRole === 'worker'),
			consumer: devices.filter((device) => device.deviceRole === 'consumer'),
		};
	}

	/**
	 * Works out the label to display for each connected device.
	 *
	 * A device is identified by its `deviceId`, and its `name` is only a display label, so two
	 * connected devices may carry the same name. Two worker cards headed by the same words are
	 * unreadable, so a name that more than one connected device carries is followed by the start
	 * of that device's own identifier, and a name only one device carries is displayed on its own.
	 *
	 * @param devices Every device currently connected.
	 * @returns The label to display for each device, by device identifier.
	 */
	static displayLabelByDeviceId(devices: Device[]): Map<string, string> {
		const deviceCountByName = new Map<string, number>();
		for (const device of devices) {
			deviceCountByName.set(device.name, (deviceCountByName.get(device.name) ?? 0) + 1);
		}
		const labels = new Map<string, string>();
		for (const device of devices) {
			const isNameShared = (deviceCountByName.get(device.name) ?? 0) > 1;
			labels.set(device.deviceId, isNameShared ? `${device.name} · ${Dashboard._shortDeviceId(device.deviceId)}` : device.name);
		}
		return labels;
	}

	/**
	 * Calculates stage capability percentages. The denominator is every advertised
	 * worker-stage capability, so a worker advertising three stages contributes three
	 * enabled stage capabilities to the total.
	 *
	 * @param workers The connected worker devices.
	 * @returns The total number of advertised stage capabilities, and one entry per stage
	 * name in alphabetical order.
	 */
	static stageStatistics(workers: Device[]): { total: number; stages: StageStatistic[] } {
		const counts = new Map<StageName, number>();
		let total = 0;
		for (const worker of workers) {
			for (const stageName of worker.stageNames) {
				counts.set(stageName, (counts.get(stageName) ?? 0) + 1);
				total += 1;
			}
		}
		return {
			total,
			stages: [...counts.entries()]
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([stageName, count]) => ({
					stageName,
					count,
					percentage: total === 0 ? 0 : (count / total) * 100,
				})),
		};
	}

	/**
	 * Shortens a device identifier to the few characters that tell one connected device from
	 * another on screen.
	 *
	 * @param deviceId The device identifier to shorten.
	 * @returns The start of the identifier, without the prefix every identifier carries.
	 */
	private static _shortDeviceId(deviceId: string): string {
		const withoutPrefix = deviceId.startsWith(deviceIdentifierPrefix)
			? deviceId.slice(deviceIdentifierPrefix.length)
			: deviceId;
		return withoutPrefix.slice(0, sharedNameSuffixLength);
	}
}
