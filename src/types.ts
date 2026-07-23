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

/** Un post real del propio feed/perfil de un influencer (no un match de búsqueda). */
export interface ProfilePost {
  platform: string;
  url: string;
  thumbnail?: string;      // screenshot en base64 o URL de imagen del CDN de la plataforma
  caption: string;
  date: string;
  likes: number;
  comments: number;
  views?: number;
  shares?: number;
}

export interface ProfileInfo {
  platform: string;
  handle: string;
  displayName?: string;
  avatar?: string;
  bio?: string;
  followers?: number;
  profileUrl: string;
}

export interface ProfileScanResult {
  handle: string;
  scannedAt: string;
  profiles: ProfileInfo[];
  posts: ProfilePost[];
  totals: {
    posts: number;
    likes: number;
    comments: number;
    views: number;
    avgLikes: number;
    avgComments: number;
    avgEngagementRate: number; // (likes+comments) / views cuando hay views, si no (likes+comments)/posts normalizado
  };
  byPlatform: Record<string, { posts: number; likes: number; comments: number; views: number }>;
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
