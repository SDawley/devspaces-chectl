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

import { Command, flags } from '@oclif/command'
import { cli } from 'cli-ux'
import * as Listr from 'listr'

import { ChectlContext } from '../../api/context'
import { batch, cheNamespace, k8sPodDownloadImageTimeout, K8SPODDOWNLOADIMAGETIMEOUT_KEY, k8sPodErrorRecheckTimeout, K8SPODERRORRECHECKTIMEOUT_KEY, k8sPodReadyTimeout, K8SPODREADYTIMEOUT_KEY, k8sPodWaitTimeout, K8SPODWAITTIMEOUT_KEY, listrRenderer, logsDirectory, LOG_DIRECTORY_KEY, skipKubeHealthzCheck } from '../../common-flags'
import { CheTasks } from '../../tasks/che'
import { ApiTasks } from '../../tasks/platforms/api'
import { findWorkingNamespace, getCommandSuccessMessage, notifyCommandCompletedSuccessfully, wrapCommandError } from '../../util'

export default class Start extends Command {
  static description = 'Start Red Hat OpenShift Dev Spaces server'

  static flags: flags.Input<any> = {
    help: flags.help({ char: 'h' }),
    chenamespace: cheNamespace,
    batch,
    'listr-renderer': listrRenderer,
    [K8SPODWAITTIMEOUT_KEY]: k8sPodWaitTimeout,
    [K8SPODREADYTIMEOUT_KEY]: k8sPodReadyTimeout,
    [K8SPODDOWNLOADIMAGETIMEOUT_KEY]: k8sPodDownloadImageTimeout,
    [K8SPODERRORRECHECKTIMEOUT_KEY]: k8sPodErrorRecheckTimeout,
    [LOG_DIRECTORY_KEY]: logsDirectory,
    'skip-kubernetes-health-check': skipKubeHealthzCheck,
  }

  async run() {
    const { flags } = this.parse(Start)
    flags.chenamespace = await findWorkingNamespace(flags)
    const ctx = await ChectlContext.initAndGet(flags, this)

    const cheTasks = new CheTasks(flags)
    const apiTasks = new ApiTasks()

    // Checks if Red Hat OpenShift Dev Spaces is already deployed
    const preInstallTasks = new Listr([
      apiTasks.testApiTasks(flags),
      {
        title: '👀  Looking for an already existing Red Hat OpenShift Dev Spaces instance',
        task: () => new Listr(cheTasks.getCheckIfCheIsInstalledTasks(flags)),
      },
    ], ctx.listrOptions)

    const logsTasks = new Listr([{
      title: 'Following Red Hat OpenShift Dev Spaces logs',
      task: () => new Listr(cheTasks.getServerLogsTasks(flags, true)),
    }], ctx.listrOptions)

    const startCheTasks = new Listr([{
      title: 'Starting Red Hat OpenShift Dev Spaces',
      task: () => new Listr(cheTasks.getSaleCheUpTasks()),
    }], ctx.listrOptions)

    try {
      await preInstallTasks.run(ctx)

      if (!ctx.isCheDeployed) {
        cli.warn('Red Hat OpenShift Dev Spaces has not been deployed yet. Use server:deploy command to deploy a new Red Hat OpenShift Dev Spaces instance.')
      } else if (ctx.isCheReady) {
        cli.info('Red Hat OpenShift Dev Spaces has been already started.')
      } else {
        await logsTasks.run(ctx)
        await startCheTasks.run(ctx)
        this.log(getCommandSuccessMessage())
      }
    } catch (err: any) {
      this.error(wrapCommandError(err))
    }

    if (!flags.batch) {
      notifyCommandCompletedSuccessfully()
    }
    this.exit(0)
  }
}
