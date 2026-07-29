import type { Device, StageName } from "@webai/protocol";

/** Maintains the devices connected to the gateway. */
export class DeviceRegistry {
	private readonly devices = new Map<string, Device>();
	private revision = 0;

	/**
	 * Adds a device or replaces the device with the same identifier.
	 *
	 * @param device - The device to store.
	 */
	add(device: Device): { kind: "joined" | "updated"; device: Device; revision: number } {
		const kind = this.devices.has(device.deviceId) ? "updated" : "joined";
		const stored = { ...device, membershipRevision: ++this.revision };
		this.devices.set(device.deviceId, stored);
		return { kind, device: stored, revision: this.revision };
	}

	/**
	 * Removes a device by its identifier.
	 *
	 * @param deviceId - The device identifier to remove.
	 */
	remove(deviceId: string): { deviceId: string; revision: number } | undefined {
		if (!this.devices.delete(deviceId)) return undefined;
		return { deviceId, revision: ++this.revision };
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

	membershipRevision(): number { return this.revision; }

	/**
	 * Finds a device by its display name and role.
	 *
	 * @param name - The device display name to find.
	 * @param role - The device role to match.
	 * @returns The matching device, or `undefined` when no device matches.
	 */
	findByName(name: string, role: Device["deviceRole"]): Device | undefined {
		return this.list().find((device) => device.name === name && device.deviceRole === role);
	}

	/**
	 * Finds a worker device that supports a stage and is not excluded.
	 *
	 * @param stage - The stage for which a worker device is needed.
	 * @param excluded - Device identifiers that must not be selected.
	 * @returns A suitable worker device, or `undefined` when none is available.
	 */
	findWorker(stage: StageName, excluded: string[] = []): Device | undefined {
		return this.list().find(
			(device) =>
				device.deviceRole === "worker" &&
				device.workerState !== "draining" && device.ready !== false &&
				(device.activeAssignments ?? 0) < (device.maxConcurrentAssignments ?? 1) &&
				device.stageNames.includes(stage) &&
				!excluded.includes(device.deviceId),
		);
	}
}
