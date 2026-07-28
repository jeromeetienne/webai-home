import type { Device, DeviceRole, StageName } from "@webai/protocol";

export type StageStatistic = {
	stageName: StageName;
	count: number;
	percentage: number;
};

export type DashboardDevices = Record<DeviceRole, Device[]>;

export function splitDevices(devices: Device[]): DashboardDevices {
	return {
		worker: devices.filter((device) => device.deviceRole === "worker"),
		consumer: devices.filter((device) => device.deviceRole === "consumer"),
	};
}

/**
 * Calculates stage capability percentages. The denominator is every advertised
 * worker-stage capability, so a worker advertising three stages contributes three
 * enabled stage capabilities to the total.
 */
export function stageStatistics(workers: Device[]): { total: number; stages: StageStatistic[] } {
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
