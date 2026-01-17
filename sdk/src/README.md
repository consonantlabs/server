# Consonant Labs TypeScript SDK

Official TypeScript/JavaScript client for the Consonant Labs Control Plane.

## Installation

```bash
npm install @consonant/sdk
# or
yarn add @consonant/sdk
# or
pnpm add @consonant/sdk
```

## Quick Start

```typescript
import { ConsonantClient } from '@consonant/sdk';

// Initialize the client
const client = new ConsonantClient({
  apiKey: 'your-api-key-here',
  baseUrl: 'https://consonantlabs.xyz', // optional, defaults to this
});

// Test the connection
const connected = await client.ping();
console.log('Connected:', connected);
```

## Usage Examples

