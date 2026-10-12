import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

export interface EventHit {
  id: number;
  cameraId: string;
  at: string;
  description: string;
  distance: number;
}

export type Embed = (text: string) => Promise<number[]>; // text-embedding-3-small in production

/**
 * Semantic search over the event log, in the same SQLite file as the events.
 *
 * For a product installed one mini PC per site, one file is the right
 * trade-off: a backup is copying a folder, moving to new hardware needs no
 * migration, and there is no database server to tune, patch or wake up at
 * 3 a.m.
 */
export function openEventStore(path: string, dimensions: number, embed: Embed) {
  const db = new Database(path);
  sqliteVec.load(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      camera_id TEXT NOT NULL,
      at TEXT NOT NULL,
      description TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS event_vectors USING vec0(embedding float[${dimensions}]);
  `);

  const insertEvent = db.prepare('INSERT INTO events (camera_id, at, description) VALUES (?, ?, ?)');
  const insertVector = db.prepare('INSERT INTO event_vectors (rowid, embedding) VALUES (?, ?)');
  const nearest = db.prepare(`
    SELECT e.id, e.camera_id AS cameraId, e.at, e.description, v.distance
    FROM event_vectors v
    JOIN events e ON e.id = v.rowid
    WHERE v.embedding MATCH ? AND k = ?
    ORDER BY v.distance
  `);

  return {
    async add(cameraId: string, at: string, description: string): Promise<number> {
      const vector = await embed(description);
      const id = db.transaction(() => {
        const { lastInsertRowid } = insertEvent.run(cameraId, at, description);
        insertVector.run(BigInt(lastInsertRowid), JSON.stringify(vector));
        return Number(lastInsertRowid);
      })();
      return id;
    },

    async search(text: string, limit = 20): Promise<EventHit[]> {
      const vector = await embed(text);
      return nearest.all(JSON.stringify(vector), limit) as EventHit[];
    },

    close: () => db.close(),
  };
}
