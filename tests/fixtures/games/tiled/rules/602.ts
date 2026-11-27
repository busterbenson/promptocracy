// Fixture rule 602: the one attribute it defines is speed, a creature's (703.1). Nothing reads it: this game is for the catalog tests.
import { defineRule } from "promptocracy/engine";

export const attributes = [
  { key: "speed", type: "number", kinds: ["creature"], missing: "Does not move", meaning: "How many tiles it moves a day." },
];

export default defineRule({ rule: 602 });
