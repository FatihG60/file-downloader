import { useState, useEffect, useCallback } from 'react'
import { DownloadProgress, StartDownloadParams, DownloaderIpcApi } from '../types.js'

export function useLargeDownloader(apiKey: string = 'electronAPI') {
  const [downloads, setDownloads] = useState<Map<string, DownloadProgress>>(new Map())
  const [defaultDestination, setDefaultDestination] = useState<string>('')

  const getApi = useCallback((): DownloaderIpcApi | undefined => {
    return (window as any)[apiKey]
  }, [apiKey])

  useEffect(() => {
    const api = getApi()
    if (!api) return

    api.getDefaultDownloadPath().then((path) => {
      if (path) setDefaultDestination(path)
    }).catch(console.error)

    api.getAllDownloads().then((list) => {
      if (list && list.length > 0) {
        const map = new Map<string, DownloadProgress>()
        list.forEach((item) => map.set(item.id, item))
        setDownloads(map)
      }
    }).catch(console.error)

    const unsubscribe = api.onProgress((progress: DownloadProgress) => {
      setDownloads((prev) => {
        const next = new Map(prev)
        next.set(progress.id, progress)
        return next
      })
    })

    return () => {
      if (unsubscribe) unsubscribe()
    }
  }, [getApi])

  const startDownload = useCallback(async (params: StartDownloadParams) => {
    const api = getApi()
    if (!api) throw new Error(`window.${apiKey} is not defined. Ensure preload exposeLargeDownloaderApi is called.`)

    const initial = await api.startDownload(params)
    setDownloads((prev) => {
      const next = new Map(prev)
      next.set(initial.id, initial)
      return next
    })
    return initial
  }, [getApi, apiKey])

  const pauseDownload = useCallback(async (id: string) => {
    const api = getApi()
    if (api) await api.pauseDownload(id)
  }, [getApi])

  const resumeDownload = useCallback(async (id: string) => {
    const api = getApi()
    if (api) await api.resumeDownload(id)
  }, [getApi])

  const cancelDownload = useCallback(async (id: string) => {
    const api = getApi()
    if (api) {
      await api.cancelDownload(id)
      setDownloads((prev) => {
        const next = new Map(prev)
        next.delete(id)
        return next
      })
    }
  }, [getApi])

  const selectDirectory = useCallback(async () => {
    const api = getApi()
    if (!api) return null
    return api.selectDirectory()
  }, [getApi])

  const showItemInFolder = useCallback(async (filePath: string) => {
    const api = getApi()
    if (api) await api.showItemInFolder(filePath)
  }, [getApi])

  return {
    downloads: Array.from(downloads.values()).reverse(),
    downloadsMap: downloads,
    defaultDestination,
    startDownload,
    pauseDownload,
    resumeDownload,
    cancelDownload,
    selectDirectory,
    showItemInFolder
  }
}
