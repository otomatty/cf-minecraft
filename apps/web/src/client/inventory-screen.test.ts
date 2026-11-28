import test from "node:test";
import assert from "node:assert/strict";
import { bindInventorySlot, containerScreenVisible, updateClosePending, INVENTORY_ROWS, TABLE_ROWS, FURNACE_ROWS, CHEST_ROWS, inventoryDisplayIndex, inventoryDisplay } from "./inventory-screen.ts";
import { durabilityBar } from "./hotbar.ts";
import { missingTile, textureIconPixels } from "./textures.ts";
import { decodedFixturePack } from "../../test/texture-pack-fixture.mjs";

const fixture = await decodedFixturePack();
const packTile = (name: string): Uint8Array => {
	const tile = fixture.tiles.get(name);
	assert.ok(tile, name);
	return tile;
};

test("inventory display maps all wire slots without mutating server state", () => {
    const slots = Array.from({length:42},(_,item) => ({item:item+1,count:item+1,damage:0}));
    const before = structuredClone(slots);
    const view = inventoryDisplay(slots);
    assert.deepEqual(INVENTORY_ROWS.map(row => row.length),[27,9,4,1]);
    assert.deepEqual(view.groups[0].map(s=>s.slot),Array.from({length:27},(_,i)=>i+9));
    assert.deepEqual(view.groups[1].map(s=>s.slot),[0,1,2,3,4,5,6,7,8]);
    assert.deepEqual(view.groups[2].map(s=>s.slot),[36,37,38,39]);
    assert.equal(view.groups[3][0].slot,40);
    for (const group of view.groups) for (const {slot,stack} of group) assert.deepEqual(stack,slots[slot]);
    assert.deepEqual(view.cursor,slots[41]);
    assert.deepEqual(slots,before);
    assert.equal(inventoryDisplay([]).cursor,null);
    assert.ok(inventoryDisplay([]).groups.flat().every(s=>s.stack===null));
});

test("pack stick and table pixels are deterministic and distinct", () => {
    const names = ["stick","crafting_table_top","crafting_table_side","crafting_table_bottom"];
    const images = names.map(name=>packTile(name));
    for (let i=0;i<names.length;i++) {
        assert.equal(images[i].length,16*16*4);
        assert.deepEqual(textureIconPixels(names[i], images[i]), new Uint8ClampedArray(images[i]));
        assert.notDeepEqual(images[i],missingTile);
        for (let j=0;j<i;j++) assert.notDeepEqual(images[i],images[j]);
    }
    assert.equal(images[0][3],0);
    assert.equal(images[0][(8*16+7)*4+3],255);
    for (const image of images.slice(1)) assert.ok(image.filter((_,i)=>i%4===3).every(a=>a===255));
});

test("WASM Inventory carries crafting preview and cursor through server-confirmed clicks", async () => {
    const { readFileSync } = await import("node:fs");
    const { ClientCore } = await import("./client-core.ts");
    const { ServerCore, Generator } = await import("../shared/server-core.ts");
    const client = new ClientCore(new WebAssembly.Instance(new WebAssembly.Module(readFileSync(new URL("../wasm/client.wasm",import.meta.url))),{}));
    const server = ServerCore.fromModule(new WebAssembly.Module(readFileSync(new URL("../wasm/server.wasm",import.meta.url))));
    server.start(2026n,Generator.Flat); server.connect(1);
    const send = (packet: Uint8Array) => {
        server.packet(1,packet); server.tick();
        for (const out of server.takeOutbox()) client.packet(out.data);
    };
    send(client.encodeHello(2));
    const log = client.itemRegistry().find(item=>item.name==="oak_log")!.id;
    const planks = client.itemRegistry().find(item=>item.name==="oak_planks")!.id;
    assert.deepEqual(client.inventorySlots[4],{item:log,count:1, damage: 0});
    const packet = client.encodeClickSlot(4,0,false);
    assert.deepEqual(client.inventorySlots[4],{item:log,count:1, damage: 0}); // Encoding does not predict changes.
    send(packet);
    assert.equal(client.inventorySlots[4],null);
    assert.deepEqual(client.inventorySlots[41],{item:log,count:1, damage: 0});
    send(client.encodeClickSlot(36,0,false));
    assert.deepEqual(client.inventorySlots[36],{item:log,count:1, damage: 0});
    assert.deepEqual(client.inventorySlots[40],{item:planks,count:4, damage: 0});
    assert.equal(client.inventorySlots[41],null);
    send(client.encodeClickSlot(40,1,false));
    assert.equal(client.inventorySlots[36],null);
    assert.equal(client.inventorySlots[40],null);
    assert.deepEqual(client.inventorySlots[41],{item:planks,count:4, damage: 0});
    send(client.encodeCloseInventory());
    assert.equal(client.inventorySlots[41],null);
    assert.deepEqual(client.inventorySlots[2],{item:planks,count:5, damage: 0});
    assert.equal(client.inventory.length,36);
});


test("slot activation sends exactly once for pointer and keyboard event sequences", () => {
    for (const { name, events, activation, button, shift, eventButton = 0, expectedShift = shift } of [
        { name: "left mouse", events: ["mousedown", "mouseup", "click"], activation: "click", button: 0, shift: false },
        { name: "shift left mouse", events: ["mousedown", "mouseup", "click"], activation: "click", button: 0, shift: true },
        { name: "Enter", events: ["keydown", "click", "keyup"], activation: "click", button: 0, shift: false },
        { name: "Space", events: ["keydown", "keyup", "click"], activation: "click", button: 0, shift: false },
        { name: "shift Enter", events: ["keydown", "click", "keyup"], activation: "click", button: 0, shift: true },
        { name: "right mouse", events: ["mousedown", "contextmenu", "mouseup"], activation: "contextmenu", button: 1, shift: false, eventButton: 2 },
        { name: "shift right mouse", events: ["mousedown", "contextmenu", "mouseup"], activation: "contextmenu", button: 1, shift: true, eventButton: 2 },
        { name: "menu key (button -1)", events: ["keydown", "contextmenu", "keyup"], activation: "contextmenu", button: 1, shift: false, eventButton: -1 },
        { name: "menu key (button 0)", events: ["keydown", "contextmenu", "keyup"], activation: "contextmenu", button: 1, shift: false, eventButton: 0 },
        { name: "Shift+F10 (button -1)", events: ["keydown", "contextmenu", "keyup"], activation: "contextmenu", button: 1, shift: true, eventButton: -1, expectedShift: false },
        { name: "Shift+F10 (button 0)", events: ["keydown", "contextmenu", "keyup"], activation: "contextmenu", button: 1, shift: true, eventButton: 0, expectedShift: false },
    ]) {
        const target = new EventTarget();
        const sent: Array<{ slot: number; button: number; shift: boolean }> = [];
        bindInventorySlot(target as HTMLButtonElement, 36, (slot, button, shift) => sent.push({slot, button, shift}));
        let activated = false;
        for (const type of events) {
            const event = Object.assign(new Event(type, { cancelable: true }), { shiftKey: shift, button: eventButton });
            target.dispatchEvent(event);
            activated ||= type === activation;
            assert.equal(sent.length, activated ? 1 : 0, `${name}: ${type}`);
            assert.equal(event.defaultPrevented, type === "contextmenu", `${name}: ${type}`);
        }
        assert.deepEqual(sent, [{ slot: 36, button, shift: expectedShift }], name);
    }
});


test("table display maps wire 41–50 without confusing materials, result and cursor", () => {
    const slots = Array.from({ length: 51 }, (_, i) => ({ item: i + 1, count: i + 1, damage: 0 }));
    const before = structuredClone(slots);
    const view = inventoryDisplay(slots, 1);
    assert.deepEqual(TABLE_ROWS.map(row => row.length), [27, 9, 9, 1]);
    assert.deepEqual(view.groups[2].map(s => s.slot), [41,42,43,44,45,46,47,48,49]);
    for (let slot = 41; slot <= 49; slot++) {
        assert.equal(inventoryDisplayIndex(slot, 1), slot + 1);
        assert.deepEqual(view.groups[2][slot - 41].stack, slots[slot + 1]);
    }
    assert.equal(inventoryDisplayIndex(50, 1), 40);
    assert.deepEqual(view.groups[3], [{ slot: 50, stack: slots[40] }]);
    assert.deepEqual(view.cursor, slots[41]);
    for (const { slot, stack } of view.groups.slice(0, 2).flat()) assert.deepEqual(stack, slots[slot]);
    assert.deepEqual(slots, before);
    assert.ok(inventoryDisplay([], 1).groups.flat().every(s => s.stack === null));
});


for (const kind of [1, 2, 3] as const) {
test(`container ${kind} reopens after close and use in one tick`, () => {
    let closePending = updateClosePending(false, { type: "close" });
    assert.equal(containerScreenVisible({ screen: kind, closePending }, kind), false);
    closePending = updateClosePending(closePending, { type: "use" });
    closePending = updateClosePending(closePending, { type: "inventory", screen: kind });
    assert.equal(closePending, false);
    assert.equal(containerScreenVisible({ screen: kind, closePending }, kind), true);
});

test(`container ${kind}: stale open Inventory cannot undo a pending close`, () => {
    let closePending = updateClosePending(false, { type: "close" });
    closePending = updateClosePending(closePending, { type: "inventory", screen: kind });
    assert.equal(closePending, true);
    assert.equal(containerScreenVisible({ screen: kind, closePending }, kind), false);
    closePending = updateClosePending(closePending, { type: "inventory", screen: 0 });
    assert.equal(closePending, false);
    assert.equal(containerScreenVisible({ screen: 0, closePending }, kind), false);
});

test(`container ${kind}: server closure hides an open screen`, () => {
    assert.equal(containerScreenVisible({ screen: kind, closePending: false }, kind), true);
    const closePending = updateClosePending(false, { type: "inventory", screen: 0 });
    assert.equal(containerScreenVisible({ screen: 0, closePending }, kind), false);
});

test(`container ${kind}: a rejected use request leaves the screen closed`, () => {
    let closePending = updateClosePending(true, { type: "use" });
    assert.equal(closePending, false);
    closePending = updateClosePending(closePending, { type: "inventory", screen: 0 });
    assert.equal(containerScreenVisible({ screen: 0, closePending }, kind), false);
});

}

test("furnace display uses wire 51–53 directly and keeps cursor separate", () => {
    const slots = Array.from({ length: 54 }, (_, i) => ({ item: i + 1, count: i + 1, damage: 0 }));
    const before = structuredClone(slots);
    const view = inventoryDisplay(slots, 2);
    assert.deepEqual(FURNACE_ROWS.map(row => row.length), [27, 9, 2, 1]);
    assert.deepEqual(view.groups[2], [51, 52].map(slot => ({ slot, stack: slots[slot] })));
    assert.deepEqual(view.groups[3], [{ slot: 53, stack: slots[53] }]);
    for (const { slot, stack } of view.groups.flat()) {
        assert.equal(inventoryDisplayIndex(slot, 2), slot);
        assert.deepEqual(stack, slots[slot]);
    }
    assert.deepEqual(view.cursor, slots[41]);
    assert.deepEqual(slots, before);
    assert.ok(inventoryDisplay([], 2).groups.flat().every(s => s.stack === null));
    assert.equal(containerScreenVisible({ screen: 1, closePending: false }, 2), false);
    assert.equal(containerScreenVisible({ screen: 2, closePending: false }, 1), false);
});

test("furnace item and block textures are deterministic and distinct", () => {
    const names = ["coal", "copper_ingot", "iron_ingot", "furnace_front", "furnace_side", "furnace_top"];
    const images = names.map(name => packTile(name));
    for (const [i, pixels] of images.entries()) {
        assert.equal(pixels.length, 16 * 16 * 4);
        assert.deepEqual(textureIconPixels(names[i], pixels), new Uint8ClampedArray(pixels));
        assert.notDeepEqual(pixels, missingTile);
        for (let j = 0; j < i; j++) assert.notDeepEqual(pixels, images[j]);
    }
});

test("chest display puts wire 54–80 above inventory and hotbar and keeps cursor separate", () => {
    const slots = Array.from({ length: 81 }, (_, i) => ({ item: i + 1, count: 1, damage: i }));
    const before = structuredClone(slots);
    const view = inventoryDisplay(slots, 3);
    const chestSlots = Array.from({ length: 27 }, (_, i) => i + 54);
    assert.deepEqual(CHEST_ROWS, [chestSlots, INVENTORY_ROWS[0], INVENTORY_ROWS[1]]);
    assert.deepEqual(view.groups.map(group => group.map(({ slot }) => slot)), CHEST_ROWS);
    for (const { slot, stack } of view.groups.flat()) {
        assert.equal(inventoryDisplayIndex(slot, 3), slot);
        assert.deepEqual(stack, slots[slot]);
    }
    assert.deepEqual(view.cursor, slots[41]);
    assert.deepEqual(slots, before);
    assert.ok(inventoryDisplay([], 3).groups.flat().every(s => s.stack === null));
    assert.equal(containerScreenVisible({ screen: 2, closePending: false }, 3), false);
    assert.equal(containerScreenVisible({ screen: 3, closePending: false }, 2), false);
});


test("durability bars hide on new items and use the remaining fraction for width and color", () => {
    assert.equal(durabilityBar(0, 48), null);
    assert.equal(durabilityBar(1, null), null);
    assert.deepEqual(durabilityBar(1, 48), { fraction: 47 / 48, color: "hsl(118, 85%, 55%)" });
    assert.deepEqual(durabilityBar(24, 48), { fraction: 0.5, color: "hsl(60, 85%, 55%)" });
    assert.deepEqual(durabilityBar(47, 48), { fraction: 1 / 48, color: "hsl(3, 85%, 55%)" });
});
