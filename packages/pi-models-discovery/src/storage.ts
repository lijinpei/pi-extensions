import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const writes = new Map<string, Promise<void>>();

/** Serialize read/modify/write operations and replace complete JSON files atomically. */
export async function updateJsonFile<T>(path: string, empty: () => T, update: (data: T) => void): Promise<void> {
	const pending = (writes.get(path) ?? Promise.resolve()).then(async () => {
		let data: T;
		try {
			data = JSON.parse(await readFile(path, "utf-8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
			data = empty();
		}
		update(data);
		await mkdir(dirname(path), { recursive: true });
		const temporary = `${path}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
			await rename(temporary, path);
		} finally {
			await rm(temporary, { force: true });
		}
	});
	const settled = pending.catch(() => {});
	writes.set(path, settled);
	try {
		await pending;
	} finally {
		if (writes.get(path) === settled) writes.delete(path);
	}
}
