const SENSITIVE_FIELDS = [
  'password',
  'token',
  'apiKey',
  'api_key',
  'secret',
  'authorization',
  'auth',
  'bearer',
  'cookie',
  'session',
  'csrf',
  'xsrf',
  'jwt',
  'privateKey',
  'private_key',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'credential',
  'credentials',
  'ssn',
  'social_security',
  'creditCard',
  'credit_card',
  'cvv',
  'pin',
  'accountNumber',
  'account_number',
  'routingNumber',
  'routing_number',
];

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_PATTERN = /(\+?1[-.]?)?\(?\d{3}\)?[-.]?\d{3}[-.]?\d{4}/g;
const IP_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const CREDIT_CARD_PATTERN = /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g;
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;

export class SensitiveDataRedactor {
  private sensitiveFields: Set<string>;
  private redactionText: string;
  private partialReveal: boolean;
  private customPatterns: Map<string, RegExp>;

  constructor(options: {
    additionalFields?: string[];
    redactionText?: string;
    partialReveal?: boolean;
    customPatterns?: Map<string, RegExp>;
  } = {}) {
    this.sensitiveFields = new Set([
      ...SENSITIVE_FIELDS,
      ...(options.additionalFields || []),
    ]);
    this.redactionText = options.redactionText || '[REDACTED]';
    this.partialReveal = options.partialReveal ?? true;
    this.customPatterns = options.customPatterns || new Map();
  }

  redact(obj: any, depth = 0, maxDepth = 10): any {
    if (depth > maxDepth) {
      return '[MAX_DEPTH_EXCEEDED]';
    }

    if (obj === null || obj === undefined) {
      return obj;
    }

    if (typeof obj === 'string') {
      return this.redactString(obj);
    }

    if (typeof obj === 'number' || typeof obj === 'boolean') {
      return obj;
    }

    if (obj instanceof Date) {
      return obj;
    }

    if (obj instanceof Error) {
      return {
        name: obj.name,
        message: this.redactString(obj.message),
        stack: process.env.NODE_ENV === 'production'
          ? '[REDACTED_IN_PRODUCTION]'
          : this.redactString(obj.stack || ''),
      };
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.redact(item, depth + 1, maxDepth));
    }

    if (typeof obj === 'object') {
      const redacted: any = {};
      for (const [key, value] of Object.entries(obj)) {
        if (this.isSensitiveField(key)) {
          redacted[key] = this.maskValue(value);
        } else {
          redacted[key] = this.redact(value, depth + 1, maxDepth);
        }
      }
      return redacted;
    }

    return obj;
  }

  private isSensitiveField(fieldName: string): boolean {
    const lowerField = fieldName.toLowerCase();
    return Array.from(this.sensitiveFields).some(
      sensitive => lowerField.includes(sensitive.toLowerCase())
    );
  }

  private maskValue(value: any): string {
    if (value === null || value === undefined) {
      return this.redactionText;
    }

    const strValue = String(value);

    if (!this.partialReveal || strValue.length < 8) {
      return this.redactionText;
    }

    if (strValue.startsWith('Bearer ')) {
      const token = strValue.substring(7);
      return `Bearer ${token.substring(0, 4)}...${token.substring(token.length - 4)}`;
    }

    return `${strValue.substring(0, 4)}...${strValue.substring(strValue.length - 4)}`;
  }

  private redactString(str: string): string {
    let redacted = str;

    redacted = redacted.replace(EMAIL_PATTERN, (match) => {
      const [local, domain] = match.split('@');
      return `${local.substring(0, 2)}***@${domain}`;
    });

    redacted = redacted.replace(PHONE_PATTERN, '***-***-****');
    redacted = redacted.replace(CREDIT_CARD_PATTERN, '**** **** **** ****');
    redacted = redacted.replace(SSN_PATTERN, '***-**-****');

    if (!this.partialReveal) {
      redacted = redacted.replace(IP_PATTERN, '***.***.***.***');
    }

    for (const pattern of this.customPatterns.values()) {
      redacted = redacted.replace(pattern, this.redactionText);
    }

    return redacted;
  }

  addSensitiveField(field: string): void {
    this.sensitiveFields.add(field);
  }

  addCustomPattern(name: string, pattern: RegExp): void {
    this.customPatterns.set(name, pattern);
  }
}

export const redactor = new SensitiveDataRedactor({
  partialReveal: process.env.NODE_ENV !== 'production',
});