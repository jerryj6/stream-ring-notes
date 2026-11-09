import { chromium, BrowserContext, Page } from "playwright";
import fs from "node:fs";
import { runNotesRelay } from "./relay.js";
import { ServiceError } from "../middleware/error-handler.js";
import { config } from "../config.js";
import type { OwnNote } from "./types.js";

export class InstagramBridge {
  private static instance: InstagramBridge | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private initializing: Promise<void> | null = null;
  private paused: ServiceError | null = null;

  private constructor() {}

  public static getInstance(): InstagramBridge {
    if (!InstagramBridge.instance) {
      InstagramBridge.instance = new InstagramBridge();
    }
    return InstagramBridge.instance;
  }

  private async init(): Promise<void> {
    if (this.context && this.page) return;
    if (this.initializing) return this.initializing;

    this.initializing = (async () => {
      const profileDir = config.igProfileDir;
      if (!fs.existsSync(profileDir)) {
        fs.mkdirSync(profileDir, { recursive: true });
      }

      const launchOptions: Parameters<typeof chromium.launchPersistentContext>[1] = {
        headless: config.igHeadless,
        chromiumSandbox: config.igChromiumSandbox,
        timeout: 15_000,
      };

      if (config.igChromeChannel && config.igChromeChannel !== "default" && config.igChromeChannel.trim() !== "") {
        launchOptions.channel = config.igChromeChannel;
      }

      this.context = await chromium.launchPersistentContext(profileDir, launchOptions);
      const context = this.context;
      this.page = context.pages()[0] ?? await context.newPage();
      context.once("close", () => {
        if (this.context === context) {
          this.context = null;
          this.page = null;
        }
      });

      this.page.on("response", (response) => {
        const url = new URL(response.url());
        if (url.origin === "https://www.instagram.com" && url.pathname.replace(/\/$/, "") === "/api/graphql"
            && [401, 403, 429].includes(response.status())) {
          this.paused = new ServiceError(503, "instagram_restricted", "Instagram restricted this session. Review the account before restarting.");
        }
      });
    })();

    try {
      await this.initializing;
    } finally {
      this.initializing = null;
    }
  }

  private pause(code: string, message: string): never {
    this.paused = new ServiceError(503, code, message);
    throw this.paused;
  }

  private async ensureInstagramPage(): Promise<Page> {
    if (this.paused) throw this.paused;
    await this.init();
    if (!this.page || !this.context) throw new Error("Browser page not initialized");
    const page = this.page;

    if (!(await this.context.cookies("https://www.instagram.com/")).some((cookie) => cookie.name === "sessionid" && cookie.value)) {
      this.pause("login_required", "Sign in to Instagram with the login wizard, then restart this service.");
    }

    if (!page.url().startsWith("https://www.instagram.com/direct/")) {
      const response = await page.goto("https://www.instagram.com/direct/inbox/", {
        waitUntil: "domcontentloaded", timeout: 15_000,
      }).catch((error: unknown) => {
        if (error instanceof Error && /net::ERR_CERT_/.test(error.message)) {
          this.pause("instagram_tls_error", "The host could not verify Instagram's TLS certificate. Fix the network connection before restarting.");
        }
        throw new ServiceError(502, "instagram_unavailable", "The Instagram inbox could not be reached.");
      });
      const status = response?.status();
      if (status === 429 || status === 403 || status === 401 || !page.url().startsWith("https://www.instagram.com/direct/")) {
        this.pause("instagram_restricted", "Instagram interrupted the session. Check the account in Instagram before restarting.");
      }
      if (!response?.ok()) throw new ServiceError(502, "instagram_unavailable", "The Instagram inbox could not be loaded.");
    }

    await page.waitForFunction(
      () => typeof (window as unknown as { require?: unknown }).require === "function",
      null,
      { timeout: 8000 },
    ).catch(() => { throw new ServiceError(502, "inbox_unavailable", "Instagram's inbox runtime did not load."); });
    const signedIn = await page.evaluate(() => {
      const req = (window as unknown as { require?: (name: string) => any }).require;
      try {
        return req?.("PolarisIsLoggedIn")?.isLoggedIn?.() !== false;
      } catch {
        return true;
      }
    });
    if (!signedIn) this.pause("login_required", "Instagram requires a fresh login. Sign in before restarting.");
    return page;
  }

  private async executeGraphQL(operation: string, variables: Record<string, unknown>): Promise<any> {
    const page = await this.ensureInstagramPage();
    const mutation = operation.endsWith("Mutation");
    const result = await page.evaluate(runNotesRelay, { operation, variables, mutation, timeoutMs: 12_000 })
      .catch(() => ({ state: "failed" } as const));

    if (this.paused) throw this.paused;
    if (result.state === "restricted") {
      this.pause("instagram_restricted", "Instagram restricted this session. Review the account before restarting.");
    }
    if (result.state === "ok") return result.data;
    if (mutation && result.state === "failed") {
      this.pause("mutation_unconfirmed", "Instagram did not confirm the change. Check your Note before restarting.");
    }
    throw new ServiceError(502, "instagram_unavailable", "The private Instagram Notes operation is unavailable.");
  }

  private async getViewerId(): Promise<string | null> {
    const page = await this.ensureInstagramPage();
    return await page.evaluate(() => {
      try {
        const match = document.cookie.match(/(?:^|;\s*)ds_user_id=([^;]+)/);
        if (match && match[1] && match[1] !== "0") return decodeURIComponent(match[1]);

        const req = (window as unknown as { require?: (mod: string) => any }).require;
        if (!req) return null;
        try {
          const currentUser = req("CurrentUserInitialData");
          if (currentUser?.USER_ID && currentUser.USER_ID !== "0") return String(currentUser.USER_ID);
          if (currentUser?.ACCOUNT_ID && currentUser.ACCOUNT_ID !== "0") return String(currentUser.ACCOUNT_ID);
        } catch {}

        try {
          const siteData = req("SiteData");
          if (siteData?.push_actor && siteData.push_actor !== "0") return String(siteData.push_actor);
        } catch {}

        return null;
      } catch {
        return null;
      }
    });
  }

  public async getOwnNotes(): Promise<OwnNote[]> {
    const data = await this.executeGraphQL("IGDInboxTrayQuery", {});
    const viewerId = await this.getViewerId();
    const rawItems = data?.response?.inbox_tray_items;
    if (!viewerId || !Array.isArray(rawItems)) {
      throw new ServiceError(502, "inbox_unavailable", "Could not verify the Instagram account and inbox.");
    }

    const ownNotes: OwnNote[] = [];
    for (const item of rawItems) {
      const note = item?.note_dict;
      if (String(note?.author_id || item?.pog_info?.pog_users?.[0]?.id || "") !== viewerId) continue;
      ownNotes.push({
        id: String(item.inbox_tray_item_id || ""),
        text: String(note?.text || ""),
        audience: Number(note?.audience ?? 0),
        hasMusic: Boolean(note?.note_response_info?.music_note_response_info),
      });
    }
    return ownNotes;
  }

  public async createRawNote(text: string, audience: number): Promise<void> {
    const viewerId = await this.getViewerId();
    if (!viewerId) throw new ServiceError(502, "inbox_unavailable", "Could not verify the Instagram account.");
    const variables = {
      input: {
        additional_params: {
          note_create_params: {
            note_style: 0,
            text,
          },
        },
        audience,
        inbox_tray_item_type: "note",
      },
    };

    const data = await this.executeGraphQL("usePolarisCreateInboxTrayItemSubmitMutation", variables);
    const createdRaw = data?.xdt_create_inbox_tray_item?.inbox_tray_item;

    if (!createdRaw?.inbox_tray_item_id) {
      this.pause("mutation_unconfirmed", "Instagram did not confirm creation. Check your Note before restarting.");
    }
  }

  public async deleteRawNote(id: string): Promise<void> {
    if (!id) throw new ServiceError(502, "inbox_unavailable", "Instagram did not provide a valid Note ID.");
    const data = await this.executeGraphQL("usePolarisDeleteInboxTrayItemSubmitMutation", { inbox_tray_item_id: id });
    // Instagram has returned null for this field after a successful deletion.
    if (!data || !Object.hasOwn(data, "xdt_delete_inbox_tray_item")) {
      this.pause("mutation_unconfirmed", "Instagram did not confirm deletion. Check your Note before restarting.");
    }
  }

  public async importStorageState(cookies: Awaited<ReturnType<BrowserContext["cookies"]>>): Promise<void> {
    await this.init();
    if (!this.context) throw new Error("Browser context not initialized");
    await this.context.addCookies(cookies);
  }

  public async close(): Promise<void> {
    if (this.context) {
      await this.context.close();
      this.context = null;
      this.page = null;
    }
  }
}
