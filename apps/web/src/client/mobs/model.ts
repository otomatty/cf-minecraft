/** Model-space texels, with the feet at y=0 and the face towards -Z. */
export type Vec3 = readonly [number, number, number];

export interface MobCube {
	readonly origin: Vec3;
	readonly size: Vec3;
	/** Top-left corner of the Bedrock box UV layout in the skin. */
	readonly uv: readonly [number, number];
	/** Width, height and depth of the UV net in texels when they differ from the model dimensions. */
	readonly uvSize?: Vec3;
	readonly mirror?: boolean;
	/** Quarter turn about X in the Bedrock rest pose, applied before the bone pose. */
	readonly pitch90Around?: Vec3;
	readonly inflate?: number;
}

export interface MobBone {
	readonly name: string;
	readonly parent?: string;
	/** Absolute model-space pivot. Child bones inherit the parent transform. */
	readonly pivot: Vec3;
	/** Bedrock rest rotation in degrees. Negative X pitches a hanging arm towards -Z. */
	readonly rotation?: Vec3;
	readonly cubes?: readonly MobCube[];
	/** A held item sprite, one model unit thick along local X. Pixel columns run
	 * towards +Z and rows towards -Y. The grip texel coordinates sit at pivot. */
	readonly itemSprite?: {
		readonly texture: string;
		readonly grip: readonly [number, number];
	};
}

export interface MobSkin {
	readonly width: number;
	readonly height: number;
	readonly url: URL;
}

export interface MobAsset {
	readonly id: `minecraft:${string}`;
	readonly texture: MobSkin;
	readonly bones: readonly MobBone[];
	/** Peak X rotation in degrees, added to the rest pose at a quarter stride. */
	readonly walkPitch: Readonly<Partial<Record<string, number>>>;
}
