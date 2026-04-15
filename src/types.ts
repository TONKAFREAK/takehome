export type SourceKey = "esbd" | "nyc";

// ---------- ESBD ----------

export interface ESBDListResponse {
  agencies: Agency[];
  lines: RFPListing[];
  page: number;
  recordsPerPage: number;
  totalRecordsFound: number;
}

export interface Agency {
  agencyname: string;
  agencyId: string;
}

export interface ESBDListRequest {
  page: number;
  urlRoot: string;
  status?: string;
  keyword?: string;
  agencyNumber?: string;
  nigp?: string;
  solicitationId?: string;
  startDate?: string;
  endDate?: string;
  dateRange?: string;
  expired?: string;
  includePreSolicitation?: boolean;
}

// ---------- Unified listing / detail ----------

export interface RFPListing {
  source: SourceKey;
  internalid: string;
  title: string;
  solicitationId: string;
  responseDue: string;
  responseTime: string;
  agencyNumber: string;
  agencyName: string;
  status: string;
  statusName: string;
  postingDate: string;
  cancelledDate: string;
  created: string;
  lastModified: string;
  nigpCodes: string;
  repostURL: string;
  url: string;
  detailUrl?: string;
}

export interface RFPDetail extends RFPListing {
  description: string;
  contactName: string;
  contactNumber: string;
  contactEmail: string;
  value: string;
  attachments: Attachment[];

  // ESBD-only metadata (optional for NYC)
  postingRequirement?: string;
  postingRequirementText?: string;
  user?: string;
  bidResponseEmail?: string;
  bidResponseURL?: string;
  optOut?: boolean;
  statutoryExemption?: string;
  hasOMR?: string;
  approved?: boolean;
  addendum?: string;
  goodsOrService?: string;
  createdFromPOD?: boolean;
  highwayDistricts?: number[];
  stateAgencyCert?: string;
  stateAgencyCertText?: string;
  ctcdCertNum?: string;
  cancellationNote?: string;
  noAwardNote?: string;
  planRepost?: boolean;
  optOutFlag?: boolean;
  awardies?: Awardee[];
  userFollows?: boolean;
  notes?: Note[];
  highwayDistrictList?: HighwayDistrict[];

  // NYC-only metadata
  tags?: string[];
  pageViewsTotal?: number;
  downloadCount?: number;
}

export interface Attachment {
  id: string;
  fileId: string;
  fileName: string;
  fileURL: string;
  fileDescription: string;
}

export interface HighwayDistrict {
  internalid: string;
  district: string;
  districtName: string;
}

export interface Awardee {
  [key: string]: unknown;
}

export interface Note {
  [key: string]: unknown;
}

// ---------- Scoring / metadata ----------

export interface ScoredRFP extends RFPDetail {
  relevanceScore: number;
  matchedCategories: string[];
  matchDetails: string;
  aiSummary?: string;
  aiShortSummary?: string;
}

export interface SourceStats {
  scanned: number;
  relevant: number;
  top: number;
}

export interface RunMetadata {
  generatedAt: Date;
  totalScanned: number;
  totalRelevant: number;
  topCount: number;
  elapsedSeconds: number;
  categoryCounts: Record<string, number>;
  sources: Record<SourceKey, SourceStats>;
}

// ---------- NYC catalog ----------

export interface NYCCatalogResponse {
  results: NYCCatalogItem[];
  resultSetSize: number;
}

export interface NYCCatalogItem {
  resource: NYCResource;
  classification: NYCClassification;
  metadata: { domain: string };
  permalink: string;
  link: string;
  owner: NYCUser;
  creator: NYCUser;
}

export interface NYCResource {
  name: string;
  id: string;
  description: string;
  attribution: string | null;
  type: string;
  createdAt: string;
  updatedAt: string;
  data_updated_at: string;
  metadata_updated_at: string;
  download_count: number;
  page_views?: {
    page_views_total?: number;
    page_views_last_week?: number;
    page_views_last_month?: number;
  };
  columns_name?: string[];
}

export interface NYCClassification {
  domain_category: string;
  domain_tags: string[];
  domain_metadata: { key: string; value: string }[];
}

export interface NYCUser {
  id: string;
  user_type: string;
  display_name: string;
}

export interface NYCViewDetail {
  id: string;
  name: string;
  description?: string;
  attribution?: string;
  metadata?: {
    attachments?: NYCViewAttachment[];
  };
}

export interface NYCViewAttachment {
  blobId?: string;
  assetId?: string;
  filename: string;
  name?: string;
}
