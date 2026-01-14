import express from "express";
import path from "path";
import { EXPLORE_STATIC, BATTLE_STATIC, EXPLORE_INDEX_HTML } from "../config/constants.js";

export function createApp() {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // static
    app.use('/explore', express.static(EXPLORE_STATIC));
    app.use('/battle', express.static(BATTLE_STATIC));

    app.get('/', (_req, res) => res.sendFile(EXPLORE_INDEX_HTML));
    return app;
}
