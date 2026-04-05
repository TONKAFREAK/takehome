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

export interface RFPListing {
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
}

export interface RFPDetail extends RFPListing {
  postingRequirement: string;
  postingRequirementText: string;
  user: string;
  description: string;
  contactName: string;
  contactNumber: string;
  contactEmail: string;
  bidResponseEmail: string;
  bidResponseURL: string;
  optOut: boolean;
  statutoryExemption: string;
  hasOMR: string;
  value: string;
  approved: boolean;
  addendum: string;
  goodsOrService: string;
  createdFromPOD: boolean;
  highwayDistricts: number[];
  stateAgencyCert: string;
  stateAgencyCertText: string;
  ctcdCertNum: string;
  cancellationNote: string;
  noAwardNote: string;
  planRepost: boolean;
  optOutFlag: boolean;
  awardies: Awardee[];
  userFollows: boolean;
  notes: Note[];
  highwayDistrictList: HighwayDistrict[];
  attachments: Attachment[];
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

// ----------------------------------------

export interface ScoredRFP extends RFPDetail {
  relevanceScore: number;
  matchedCategories: string[];
  matchDetails: string;
  aiSummary?: string;
}

export interface RunMetadata {
  generatedAt: Date;
  totalScanned: number;
  totalRelevant: number;
  topCount: number;
  elapsedSeconds: number;
  categoryCounts: Record<string, number>;
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
