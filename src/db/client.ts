import { SQL } from "bun";
import { config } from "../config.ts";

export const db = new SQL(config.databaseUrl || "postgres://localhost/missing");
