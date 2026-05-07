import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { statsManager } from "../utils/statsManager.js";
import { rentalManager } from "../utils/rentalManager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function startDashboard(api, botData) {
    const app = express();
    const port = process.env.PORT || 3000;

    app.use(cors());
    app.use(express.json());
    app.use(express.static(path.join(__dirname, "public")));

    // API: Bot Info
    app.get("/api/status", (req, res) => {
        const up = process.uptime();
        const h = Math.floor(up / 3600);
        const m = Math.floor((up % 3600) / 60);
        const s = Math.floor(up % 60);
        
        res.json({
            uptime: `${h}h ${m}m ${s}s`,
            memory: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2) + " MB",
            commands: Object.keys(botData.allCommands).length,
            modules: botData.moduleInfo.length,
            events: botData.eventHandlers.length,
            prefix: botData.prefix
        });
    });

    // API: Commands
    app.get("/api/commands", (req, res) => {
        const cmds = botData.moduleInfo.map(mod => ({
            name: mod.name,
            description: mod.description || "Không có mô tả",
            commands: mod.commands || []
        }));
        res.json(cmds);
    });

    // API: Groups
    app.get("/api/groups", async (req, res) => {
        try {
            const groupsResp = await api.getAllGroups();
            const groupIds = Object.keys(groupsResp.gridVerMap || {});
            const groupInfoResp = await api.getGroupInfo(groupIds);
            const groupMap = groupInfoResp.gridInfoMap || {};

            const groups = groupIds.map(id => {
                const info = groupMap[id];
                return {
                    id,
                    name: info ? (info.name || info.groupName || "Không tên") : "Không tên",
                    memberCount: info ? (info.num_member || info.totalMember || info.numMember || (info.memberIds ? info.memberIds.length : 0)) : 0,
                    isRented: rentalManager.isRented(id),
                    expiry: rentalManager.getExpiry(id)
                };
            });
            res.json(groups);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // API: Admins
    app.get("/api/admins", async (req, res) => {
        try {
            const ids = botData.adminIds;
            const result = await api.getUserInfo(ids);
            const profiles = result?.changed_profiles || result?.profiles || result || {};
            
            const admins = ids.map(id => {
                const p = profiles[id];
                return {
                    id,
                    name: p?.displayName || p?.zaloName || "Người dùng Zalo",
                    avatar: p?.avatar
                };
            });
            res.json(admins);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post("/api/restart", (req, res) => {
        res.json({ success: true, message: "Đang khởi động lại..." });
        setTimeout(() => {
            const child = spawn("node", ["bot.js"], {
                cwd: process.cwd(),
                detached: true,
                stdio: "inherit",
                shell: true
            });
            child.unref();
            process.exit(0);
        }, 1000);
    });

    app.post("/api/shutdown", (req, res) => {
        res.json({ success: true, message: "Đang tắt bot..." });
        setTimeout(() => {
            process.exit(0);
        }, 1000);
    });

    app.listen(port, () => {
        console.log(`\n[ DASHBOARD ] Server is running at http://localhost:${port}`);
    });

    return app;
}
