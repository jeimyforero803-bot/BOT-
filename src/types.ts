export interface Mention {
  platform: string;
  author: string;
  text: string;
  url: string;
  date: string;
  likes?: number;
  tipo?: string;
  is_influencer?: boolean;
  follower_count?: number;
  screenshot?: string;
}

export interface Comment {
  platform: string;
  author: string;
  text: string;
  url: string;
  url_fuente: string;
  date: string;
  likes?: number;
  screenshot?: string;
}

export interface Etiquetado {
  platform: string;
  quien: string;
  texto: string;
  url: string;
  date: string;
  tipo: 'mencion' | 'etiqueta' | 'hashtag';
}

export interface Alert {
  level: 'info' | 'warning' | 'critical';
  tipo: string;
  mensaje: string;
  plataforma?: string;
  url?: string;
}

export interface ScanPayload {
  keyword: string;
  brand: string;
  scannedAt: string;
  totalMentions: number;
  platforms: Record<string, { mentions: number; comments: number; etiquetados: number }>;
  sentiment: number;
  sentimentLabel: 'positivo' | 'negativo' | 'neutro';
  topMentions: Mention[];
  comments: Comment[];
  etiquetados: Etiquetado[];
  influencers: Mention[];
  alerts: Alert[];
  summary: string;
  keywords: string[];
}
