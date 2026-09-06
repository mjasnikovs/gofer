export function imageFiles(files: readonly File[]): readonly File[] {
    return files
        .filter(file => file.type.startsWith('image/'))
        .map(file =>
            file.name === '' ?
                new File([file], `pasted-image.${file.type.slice('image/'.length)}`, {
                    type: file.type
                })
            :   file
        )
}

export function clipboardItemImages(clipboard: DataTransfer): readonly File[] {
    return imageFiles(
        Array.from(clipboard.items)
            .filter(item => item.kind === 'file')
            .map(item => item.getAsFile())
            .filter((file): file is File => file !== null)
    )
}
