import { BaseDirectory, readTextFile } from "@tauri-apps/plugin-fs";
import { writeDocumentTextFile } from "../sync/webdav.ts";

const PROPOSALS_FILE = "passage-proposals.json";
const SCHEMA_VERSION = 1;
const MAX_PROPOSALS = 100;

export interface PassageProposal {
  id: string;
  episodeId: string;
  instruction: string;
  generatedText: string;
  createdAt: string;
  appliedAt?: string;
}

interface PassageProposalDocument {
  schemaVersion: typeof SCHEMA_VERSION;
  proposals: PassageProposal[];
}

function projectPath(projectId: string): string {
  return `litra/projects/${projectId}/${PROPOSALS_FILE}`;
}

function isProposal(value: unknown): value is PassageProposal {
  if (typeof value !== "object" || value === null) return false;
  const proposal = value as Partial<PassageProposal>;
  return typeof proposal.id === "string" &&
    typeof proposal.episodeId === "string" &&
    typeof proposal.instruction === "string" &&
    typeof proposal.generatedText === "string" &&
    typeof proposal.createdAt === "string" &&
    (proposal.appliedAt === undefined || typeof proposal.appliedAt === "string");
}

async function loadDocument(projectId: string): Promise<PassageProposalDocument> {
  try {
    const text = await readTextFile(projectPath(projectId), { baseDir: BaseDirectory.Document });
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as PassageProposalDocument).proposals)) {
      return {
        schemaVersion: SCHEMA_VERSION,
        proposals: (parsed as PassageProposalDocument).proposals.filter(isProposal),
      };
    }
  } catch {
    // 未作成または破損したキャッシュは空として扱い、次回保存時に再構築する。
  }
  return { schemaVersion: SCHEMA_VERSION, proposals: [] };
}

async function saveDocument(projectId: string, document: PassageProposalDocument): Promise<void> {
  await writeDocumentTextFile(projectPath(projectId), JSON.stringify(document, null, 2));
}

export async function cachePassageProposal(
  projectId: string,
  input: Pick<PassageProposal, "episodeId" | "instruction" | "generatedText">,
): Promise<PassageProposal> {
  const document = await loadDocument(projectId);
  const proposal: PassageProposal = {
    id: crypto.randomUUID(),
    episodeId: input.episodeId,
    instruction: input.instruction,
    generatedText: input.generatedText,
    createdAt: new Date().toISOString(),
  };
  document.proposals.unshift(proposal);
  document.proposals = document.proposals.slice(0, MAX_PROPOSALS);
  await saveDocument(projectId, document);
  return proposal;
}

export async function listPassageProposals(
  projectId: string,
  episodeId?: string,
  includeApplied = false,
): Promise<PassageProposal[]> {
  const document = await loadDocument(projectId);
  return document.proposals.filter(
    (proposal) => (!episodeId || proposal.episodeId === episodeId) && (includeApplied || !proposal.appliedAt),
  );
}

export async function getPassageProposal(projectId: string, proposalId: string): Promise<PassageProposal | undefined> {
  const document = await loadDocument(projectId);
  return document.proposals.find((proposal) => proposal.id === proposalId);
}

export async function markPassageProposalApplied(projectId: string, proposalId: string): Promise<PassageProposal | undefined> {
  const document = await loadDocument(projectId);
  const proposal = document.proposals.find((item) => item.id === proposalId);
  if (!proposal) return undefined;
  proposal.appliedAt = new Date().toISOString();
  await saveDocument(projectId, document);
  return proposal;
}
