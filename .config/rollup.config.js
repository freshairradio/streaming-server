import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import run from "@rollup/plugin-run";
import builtins from "builtin-modules";
import json from "@rollup/plugin-json";
import rimraf from "rimraf";
import polyfill from "rollup-plugin-node-polyfills";
const production = !process.env.ROLLUP_WATCH;
import fs from "fs";
import path from "path";
const pkg = JSON.parse(
  fs.readFileSync(path.resolve("./package.json"), "utf-8")
);
const external = Object.keys(pkg.dependencies || []);
import { config } from "dotenv";
config();
rimraf.sync("./dist");
export default {
  input: process.env.ENTRYPOINT,
  output: {
    dir: "dist",
    format: "cjs"
  },
  external: [...builtins, ...external],
  plugins: [
    commonjs(),
    resolve(),
    polyfill(),
    json(),

    // production && terser(),
    !production && run()
  ]
};
