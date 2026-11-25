import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from './icons.tsx';

export type ErrorBoundaryProps = {
  children: ReactNode;
  /** Değişince sınır sıfırlanır (kabukta: currentPath). */
  resetKey?: unknown;
  /** 'section': kabuk içinde içerik alanı (h2). 'page': kabuksuz tam sayfa (h1). Varsayılan 'section'. */
  variant?: 'section' | 'page';
  /** Ana sayfa bağlantısı. Verilmezse Merkez: { href: '/home', label: t('boundary.homeHub') }. */
  home?: { href: string; label: string };
  /** Kayıt kancası (ileride sunucuya hata kaydı için). Varsayılan: console.error. */
  onError?: (error: unknown, info: { componentStack?: string | null }) => void;
};

type State = { error: unknown | null; hasError: boolean };

function techText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  try {
    return String(error);
  } catch {
    return 'Error';
  }
}

export function BoundaryFallback({ error, variant = 'section', home }: { error: unknown; variant?: 'section' | 'page'; home?: ErrorBoundaryProps['home'] }) {
  const { t } = useTranslation('shell');
  const target = home ?? { href: '/home', label: t('boundary.homeHub') };
  const Heading = variant === 'page' ? 'h1' : 'h2';
  return (
    <div className="sod-err" role="alert" data-sod-boundary={variant}>
      <div className="sod-err-card">
        <span className="sod-err-ico" aria-hidden="true">
          <Icon name="warn" size={24} />
        </span>
        <Heading className="sod-err-title">{variant === 'page' ? t('boundary.pageTitle') : t('boundary.title')}</Heading>
        <p className="sod-err-body">{t('boundary.body')}</p>
        <div className="sod-err-actions">
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            {t('boundary.reload')}
          </button>
          <a className="btn btn-secondary" href={target.href}>
            {target.label}
          </a>
        </div>
        <details className="sod-err-tech">
          <summary>{t('boundary.tech')}</summary>
          <code>{techText(error)}</code>
        </details>
      </div>
    </div>
  );
}

/** Çöken alt ağacı söküp yedek ekran gösterir; çevresi (bant, menü, sağlayıcılar) ayakta kalır. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  state: State = { error: null, hasError: false };

  static getDerivedStateFromError(error: unknown): State {
    return { error, hasError: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    if (this.props.onError) this.props.onError(error, info);
    else console.error(error, info.componentStack);
  }

  componentDidUpdate(prev: ErrorBoundaryProps) {
    if (this.state.hasError && !Object.is(prev.resetKey, this.props.resetKey)) this.setState({ error: null, hasError: false });
  }

  render() {
    if (this.state.hasError) return <BoundaryFallback error={this.state.error} variant={this.props.variant} home={this.props.home} />;
    return this.props.children;
  }
}
