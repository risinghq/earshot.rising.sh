let sourceSeq = 0;

// Seeds a playlist-backed category pool straight into D1 so a test does not
// need a Deezer feed fetch.
export async function seedCatalog(
  db: D1Database,
  slug: string,
  tracks: Array<{
    id: number;
    title: string;
    artist?: string;
    year?: number;
  }>,
  decade?: number,
) {
  await db
    .prepare(
      `INSERT INTO category_sources (category, kind, ref, title, decade, position)
       VALUES (?1, 'deezer_playlist', ?2, 'test list', ?3, 0)`,
    )
    .bind(slug, `test-${slug}-${sourceSeq++}`, decade ?? null)
    .run();
  const source = await db
    .prepare(
      "SELECT id FROM category_sources WHERE category = ?1 ORDER BY id DESC",
    )
    .bind(slug)
    .first<{ id: number }>();
  const statements: D1PreparedStatement[] = [];
  tracks.forEach((track, position) => {
    statements.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO catalog_tracks
             (deezer_id, title, artist, cover, link, year, updated_at)
           VALUES (?1, ?2, ?3, NULL, NULL, ?4, 0)`,
        )
        .bind(
          track.id,
          track.title,
          track.artist ?? "Artist",
          track.year ?? null,
        ),
      db
        .prepare(
          `INSERT INTO catalog_members (source_id, deezer_id, position)
           VALUES (?1, ?2, ?3)`,
        )
        .bind(source!.id, track.id, position),
    );
  });
  for (let index = 0; index < statements.length; index += 100)
    await db.batch(statements.slice(index, index + 100));
}
