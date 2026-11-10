// Camera maths in the game's conventions: +X east, +Y up, +Z south.
// Yaw 0 looks south and grows clockwise seen from above (90 = west);
// pitch +90 looks straight down. Angles are in degrees.

export type Vec3 = [number, number, number];

const RAD = Math.PI / 180;

export function forward(yaw: number, pitch: number): Vec3 {
	const cp = Math.cos(pitch * RAD);
	return [-Math.sin(yaw * RAD) * cp, -Math.sin(pitch * RAD), Math.cos(yaw * RAD) * cp];
}

/** Horizontal unit vector to the right of the view direction. */
export function right(yaw: number): Vec3 {
	return [-Math.cos(yaw * RAD), 0, -Math.sin(yaw * RAD)];
}

function cross(a: Vec3, b: Vec3): Vec3 {
	return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v: Vec3): Vec3 {
	const l = Math.hypot(v[0], v[1], v[2]) || 1;
	return [v[0] / l, v[1] / l, v[2] / l];
}

/**
 * Projection * view for a camera at the origin (positions are sent to the GPU
 * relative to the camera). Column-major, depth range 0..1.
 */
export function viewProjection(yaw: number, pitch: number, fovY: number, aspect: number, near: number, far: number): Float32Array {
	const f = forward(yaw, pitch);
	// At exactly +-90 pitch the forward vector is vertical; fall back to the yaw's right vector.
	let r = cross(f, [0, 1, 0]);
	r = Math.hypot(r[0], r[1], r[2]) < 1e-6 ? right(yaw) : normalize(r);
	const u = cross(r, f);

	const t = 1 / Math.tan((fovY * RAD) / 2);
	const a = far / (near - far);
	const b = (near * far) / (near - far);
	// P * V with V rows = r, u, -f and P = diag(t/aspect, t, a) plus the perspective terms.
	const m = new Float32Array(16);
	const px = t / aspect;
	m[0] = px * r[0];
	m[4] = px * r[1];
	m[8] = px * r[2];
	m[1] = t * u[0];
	m[5] = t * u[1];
	m[9] = t * u[2];
	m[2] = a * -f[0];
	m[6] = a * -f[1];
	m[10] = a * -f[2];
	m[14] = b;
	m[3] = f[0];
	m[7] = f[1];
	m[11] = f[2];
	return m;
}

/** Six frustum planes (a, b, c, d) with normals pointing inward, from a column-major matrix. */
export function frustumPlanes(m: Float32Array): Float32Array {
	const row = (i: number): [number, number, number, number] => [m[i], m[4 + i], m[8 + i], m[12 + i]];
	const [r0, r1, r2, r3] = [row(0), row(1), row(2), row(3)];
	const planes = new Float32Array(24);
	const set = (i: number, p: number[]) => planes.set(p, i * 4);
	set(0, r3.map((v, k) => v + r0[k])); // left
	set(1, r3.map((v, k) => v - r0[k])); // right
	set(2, r3.map((v, k) => v + r1[k])); // bottom
	set(3, r3.map((v, k) => v - r1[k])); // top
	set(4, r2); // near (depth 0..1)
	set(5, r3.map((v, k) => v - r2[k])); // far
	return planes;
}

/** True when the axis-aligned box [min, min + size] is at least partly inside all planes. */
export function boxInFrustum(planes: Float32Array, minX: number, minY: number, minZ: number, size: number): boolean {
	for (let i = 0; i < 24; i += 4) {
		const a = planes[i];
		const b = planes[i + 1];
		const c = planes[i + 2];
		// Corner furthest along the plane normal.
		const x = a >= 0 ? minX + size : minX;
		const y = b >= 0 ? minY + size : minY;
		const z = c >= 0 ? minZ + size : minZ;
		if (a * x + b * y + c * z + planes[i + 3] < 0) return false;
	}
	return true;
}
