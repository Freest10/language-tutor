import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { APP_NAME } from '@lt/shared';

import { App } from '../src/App';

describe('App', () => {
  it('рендерит название приложения', () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: APP_NAME })).toBeInTheDocument();
  });
});
