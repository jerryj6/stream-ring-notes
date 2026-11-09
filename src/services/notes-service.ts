import { InstagramBridge } from "../bridge/instagram-bridge.js";
import type { OwnNote } from "../bridge/types.js";
import { config } from "../config.js";
import { ServiceError } from "../middleware/error-handler.js";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export class NotesService {
  constructor(private bridge: Pick<InstagramBridge, "getOwnNotes" | "createRawNote" | "deleteRawNote"> = InstagramBridge.getInstance()) {}

  public async checkInbox(): Promise<void> {
    await this.getCurrentNote();
  }

  public async setFromCapture(text: string): Promise<void> {
    let clipped = "";
    for (const { segment } of graphemes.segment(text)) {
      if (clipped.length + segment.length > config.noteCharLimit) break;
      clipped += segment;
    }
    if (!clipped.trim()) throw new ServiceError(400, "invalid_note", "The capture could not be shortened to a usable note.");

    const current = await this.getCurrentNote();
    if (current?.text === clipped && current.audience === config.defaultAudience && !current.hasMusic) return;
    if (current) await this.bridge.deleteRawNote(current.id);
    await this.bridge.createRawNote(clipped, config.defaultAudience);
  }

  public async clearFromCapture(): Promise<void> {
    const current = await this.getCurrentNote();
    if (current) await this.bridge.deleteRawNote(current.id);
  }

  private async getCurrentNote(): Promise<OwnNote | undefined> {
    const notes = await this.bridge.getOwnNotes();
    if (notes.length > 1 || (notes.length === 1 && !notes[0].id)) {
      throw new ServiceError(502, "inbox_unavailable", "Could not identify one active Instagram Note.");
    }
    return notes[0];
  }
}
