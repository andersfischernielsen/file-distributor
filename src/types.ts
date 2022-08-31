interface PathConfiguration {
  source: string;
  destination: string;
}

export interface RepositoryConfiguration {
  version?: string;
  automerge?: boolean;
  files?: PathConfiguration[];
  values?: { [key: string]: string };
}

export interface RepositoryDetails {
  owner: string;
  repo: string;
}

export interface Template {
  path: string;
  contents: string;
}