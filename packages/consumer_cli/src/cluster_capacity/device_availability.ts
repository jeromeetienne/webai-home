import type { Device } from '@webai/protocol';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	DeviceAvailability — the availability rule the gateway itself applies to a worker
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Reads how free a worker device is to take on more work, by the same rule the central
 * gateway applies when it places a stage (`DeviceRegistry.findWorker` and
 * `WorkerPlacement.reusableWorker`): not draining, not explicitly marked unready, and holding
 * fewer active assignments than the concurrency limit it advertised.
 */
export class DeviceAvailability {
	/**
	 * Reports whether a worker device may currently be given another assignment.
	 *
	 * @param device The device to check.
	 * @returns `true` when the device is not draining, not explicitly marked unready, and
	 * below its advertised concurrency limit.
	 */
	static isAvailable(device: Device): boolean {
		return device.workerState !== 'draining'
			&& device.ready !== false
			&& (device.activeAssignments ?? 0) < (device.maxConcurrentAssignments ?? 1);
	}

	/**
	 * Reads how many more assignments a worker device may currently take on.
	 *
	 * @param device The device to check.
	 * @returns The free slots on the device, or `0` when it is not available at all.
	 */
	static availableCapacity(device: Device): number {
		if (DeviceAvailability.isAvailable(device) === false) return 0;
		return (device.maxConcurrentAssignments ?? 1) - (device.activeAssignments ?? 0);
	}
}
