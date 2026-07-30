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
 * Turns the gateway's raw device list into the summaries the monitor page displays.
 *
 * Both calculations are here rather than on the page itself, so the same numbers can be
 * checked by the gateway's own tests without a browser.
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
}
