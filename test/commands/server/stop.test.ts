/**
 * Copyright (c) 2019-2021 Red Hat, Inc.
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 *
 * Contributors:
 *   Red Hat, Inc. - initial API and implementation
 */

import { expect, test } from '@oclif/test'

describe('stop', () => {
  test
    .stdout()
    .command(['stop'])
    .it('stop Red Hat OpenShift Dev Spaces server', ctx => {
      expect(ctx.stdout).to.contain('Successfully stopped')
    })
})
