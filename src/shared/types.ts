export type UserRole = "admin" | "user";
export type FileVisibility = "public" | "private" | "password";

export type PublicFileStatus =
  | "available"
  | "password_required"
  | "private"
  | "expired"
  | "not_found";

export type UserDto = {
  id: string;
  username: string;
  email: string | null;
  role: UserRole;
};

export type FileDto = {
  id: string;
  originalFilename: string;
  safeFilename: string;
  mimeType: string;
  detectedType: string;
  sizeBytes: number;
  sha256: string;
  viewCount: number;
  downloadCount: number;
  visibility: FileVisibility;
  vanityPath: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  ownerUsername?: string;
  directUrl: string;
  downloadUrl: string;
  previewUrl: string;
  viewUrl: string;
  vanityUrl: string | null;
};

export type InviteDto = {
  id: string;
  maxUses: number | null;
  uses: number;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export type MeResponse = {
  setupRequired: boolean;
  user: UserDto | null;
  maxFileSizeBytes: number;
};

export type PublicFileResponse = {
  status: PublicFileStatus;
  file?: FileDto;
};

export type UploadResponse = {
  files: FileDto[];
};

export type ChunkedUploadSessionResponse = {
  uploadId: string;
  chunkSizeBytes: number;
  chunkCount: number;
  receivedChunks: number;
};

export type ChunkedUploadCompleteResponse = {
  file: FileDto;
};
