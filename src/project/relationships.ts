import { BaseDirectory, readTextFile } from "@tauri-apps/plugin-fs";
import { writeDocumentTextFile } from "../sync/webdav.ts";
import {
  isCharacterRelationshipMap,
  type CharacterRelationshipMap,
  type EpisodeRelationshipGroup,
} from "./schema.ts";

const RELATIONSHIPS_FILE = "relationships.json";

function projectPath(projectId: string, ...parts: string[]): string {
  return `litra/projects/${projectId}/${parts.join("/")}`;
}

export async function loadRelationships(projectId: string): Promise<CharacterRelationshipMap> {
  try {
    const text = await readTextFile(projectPath(projectId, RELATIONSHIPS_FILE), {
      baseDir: BaseDirectory.Document,
    });
    const parsed: unknown = JSON.parse(text);
    if (isCharacterRelationshipMap(parsed)) {
      return parsed;
    }
  } catch {
    // ファイルがない・壊れている場合は空を返す
  }
  return { groups: [] };
}

export async function saveRelationships(
  projectId: string,
  map: CharacterRelationshipMap,
): Promise<void> {
  await writeDocumentTextFile(
    projectPath(projectId, RELATIONSHIPS_FILE),
    JSON.stringify(map, null, 2),
  );
}

export function removeCharacterRelationships(
  map: CharacterRelationshipMap,
  characterId: string,
): void {
  for (const group of map.groups) {
    group.relationships = group.relationships.filter(
      (rel) => rel.characterAId !== characterId && rel.characterBId !== characterId,
    );
  }
  map.groups = map.groups.filter((group) => group.relationships.length > 0);
}

export function removeEpisodeRelationships(
  map: CharacterRelationshipMap,
  episodeId: string,
): void {
  map.groups = map.groups.filter((group) => group.episodeId !== episodeId);
}

export function getOrCreateRelationshipGroup(
  map: CharacterRelationshipMap,
  episodeId: string,
): EpisodeRelationshipGroup {
  const existing = map.groups.find((group) => group.episodeId === episodeId);
  if (existing) return existing;
  const created: EpisodeRelationshipGroup = { episodeId, relationships: [] };
  map.groups.push(created);
  return created;
}
