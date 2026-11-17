import test from "node:test";
import assert from "node:assert/strict";
import { bindInventorySlot, INVENTORY_ROWS, inventoryDisplay } from "./inventory-screen.ts";
import { paintTexture } from "./textures.ts";

test("inventory display maps all wire slots without mutating server state", () => {
    const slots = Array.from({length:42},(_,item) => ({item:item+1,count:item+1}));
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

test("original stick and table pixels are deterministic and distinct", () => {
    const names = ["stick","crafting_table_top","crafting_table_side","crafting_table_bottom"];
    const images = names.map(name=>paintTexture(name));
    for (let i=0;i<names.length;i++) {
        assert.equal(images[i].length,16*16*4);
        assert.deepEqual(images[i],paintTexture(names[i]));
        assert.notDeepEqual(images[i],paintTexture("unknown_texture"));
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
    assert.deepEqual(client.inventorySlots[4],{item:log,count:1});
    const packet = client.encodeClickSlot(4,0,false);
    assert.deepEqual(client.inventorySlots[4],{item:log,count:1}); // Encoding does not predict changes.
    send(packet);
    assert.equal(client.inventorySlots[4],null);
    assert.deepEqual(client.inventorySlots[41],{item:log,count:1});
    send(client.encodeClickSlot(36,0,false));
    assert.deepEqual(client.inventorySlots[36],{item:log,count:1});
    assert.deepEqual(client.inventorySlots[40],{item:planks,count:4});
    assert.equal(client.inventorySlots[41],null);
    send(client.encodeClickSlot(40,1,false));
    assert.equal(client.inventorySlots[36],null);
    assert.equal(client.inventorySlots[40],null);
    assert.deepEqual(client.inventorySlots[41],{item:planks,count:4});
    send(client.encodeCloseInventory());
    assert.equal(client.inventorySlots[41],null);
    assert.deepEqual(client.inventorySlots[2],{item:planks,count:5});
    assert.equal(client.inventory.length,36);
});


test("slot activation sends exactly once for pointer and keyboard event sequences", () => {
    for (const { name, events, activation, button, shift } of [
        { name: "left mouse", events: ["mousedown", "mouseup", "click"], activation: "click", button: 0, shift: false },
        { name: "shift left mouse", events: ["mousedown", "mouseup", "click"], activation: "click", button: 0, shift: true },
        { name: "Enter", events: ["keydown", "click", "keyup"], activation: "click", button: 0, shift: false },
        { name: "Space", events: ["keydown", "keyup", "click"], activation: "click", button: 0, shift: false },
        { name: "shift Enter", events: ["keydown", "click", "keyup"], activation: "click", button: 0, shift: true },
        { name: "right mouse", events: ["mousedown", "contextmenu", "mouseup"], activation: "contextmenu", button: 1, shift: false },
        { name: "shift right mouse", events: ["mousedown", "contextmenu", "mouseup"], activation: "contextmenu", button: 1, shift: true },
        { name: "menu key", events: ["keydown", "contextmenu", "keyup"], activation: "contextmenu", button: 1, shift: false },
        { name: "Shift+F10", events: ["keydown", "contextmenu", "keyup"], activation: "contextmenu", button: 1, shift: true },
    ]) {
        const target = new EventTarget();
        const sent: Array<{ slot: number; button: number; shift: boolean }> = [];
        bindInventorySlot(target as HTMLButtonElement, 36, (slot, button, shift) => sent.push({slot, button, shift}));
        let activated = false;
        for (const type of events) {
            const event = Object.assign(new Event(type, { cancelable: true }), { shiftKey: shift });
            target.dispatchEvent(event);
            activated ||= type === activation;
            assert.equal(sent.length, activated ? 1 : 0, `${name}: ${type}`);
            assert.equal(event.defaultPrevented, type === "contextmenu", `${name}: ${type}`);
        }
        assert.deepEqual(sent, [{ slot: 36, button, shift }], name);
    }
});
