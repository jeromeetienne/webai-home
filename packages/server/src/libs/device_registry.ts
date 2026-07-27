import type { Device, StageName } from "@webai/protocol";

/** Maintains the devices connected to the server. */
export class DeviceRegistry {
	private readonly devices = new Map<string, Device>();

	/**
	 * Adds a device or replaces the device with the same identifier.
	 *
	 * @param device - The device to store.
	 */
	add(device: Device): void {
		this.devices.set(device.deviceId, device);
	}

	/**
	 * Removes a device by its identifier.
	 *
	 * @param deviceId - The device identifier to remove.
	 */
	remove(deviceId: string): void {
		this.devices.delete(deviceId);
	}

	/**
	 * Looks up a device by its identifier.
	 *
	 * @param deviceId - The device identifier to look up.
	 * @returns The matching device, or `undefined` when no device exists.
	 */
	get(deviceId: string): Device | undefined {
		return this.devices.get(deviceId);
	}

	/**
	 * Returns all currently registered devices.
	 *
	 * @returns A new array containing the registered devices.
	 */
	list(): Device[] {
		return [...this.devices.values()];
	}

	/**
	 * Finds a device by its display name and role.
	 *
	 * @param name - The device display name to find.
	 * @param role - The device role to match.
	 * @returns The matching device, or `undefined` when no device matches.
	 */
	findByName(name: string, role: Device["role"]): Device | undefined {
		return this.list().find((device) => device.name === name && device.role === role);
	}

	/**
	 * Finds a volunteer device that supports a stage and is not excluded.
	 *
	 * @param stage - The stage for which a volunteer device is needed.
	 * @param excluded - Device identifiers that must not be selected.
	 * @returns A suitable volunteer device, or `undefined` when none is available.
	 */
	findVolunteer(stage: StageName, excluded: string[] = []): Device | undefined {
		return this.list().find(
			(device) =>
				device.role === "volunteer" &&
				device.stageNames.includes(stage) &&
				!excluded.includes(device.deviceId),
		);
	}
}
