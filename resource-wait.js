const abortError = () => new DOMException('Loading cancelled', 'AbortError')

export const throwIfAborted = signal => {
    if (signal?.aborted) throw abortError()
}

export const withAbort = (promise, signal) => new Promise((resolve, reject) => {
    const abort = () => reject(abortError())
    // Observe the original promise even if cancellation wins the race.
    Promise.resolve(promise).then(resolve, reject).finally(() =>
        signal?.removeEventListener('abort', abort))
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
})

export const waitForEvent = (target, events, signal, pollAfterMS) =>
    new Promise((resolve, reject) => {
        let timer
        const cleanup = () => {
            clearTimeout(timer)
            events.forEach(event => target.removeEventListener(event, done))
            signal?.removeEventListener('abort', abort)
        }
        const done = () => {
            cleanup()
            resolve()
        }
        const abort = () => {
            cleanup()
            reject(abortError())
        }
        if (signal?.aborted) return abort()
        events.forEach(event => target.addEventListener(event, done))
        signal?.addEventListener('abort', abort, { once: true })
        if (pollAfterMS !== undefined) timer = setTimeout(done, pollAfterMS)
    })

// Accessing fonts.ready during style changes can crash older WebKit.
// Poll as well as listening: WebKit may omit the loadingdone event.
export const waitForFonts = async (doc, signal) => {
    throwIfAborted(signal)
    doc.documentElement.getBoundingClientRect()
    while (doc.fonts?.status === 'loading' && doc.defaultView) {
        await waitForEvent(doc.fonts, ['loadingdone', 'loadingerror'], signal, 25)
        throwIfAborted(signal)
    }
}

export const waitForImages = async (doc, signal) => {
    throwIfAborted(signal)
    await Promise.all(Array.from(doc.querySelectorAll('img'), image => {
        image.loading = 'eager'
        if (!image.complete) return waitForEvent(image, ['load', 'error'], signal)
    }))
}
