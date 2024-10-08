import { EncapsulationKind } from "./EncapsulationKind";
import { getEncapsulationKindInfo } from "./getEncapsulationKindInfo";
import { isBigEndian } from "./isBigEndian";
import { LengthCode, getLengthCodeForObjectSize, lengthCodeToObjectSizes } from "./lengthCodes";
import { EXTENDED_PID, SENTINEL_PID } from "./reservedPIDs";

export type CdrWriterOpts = {
  buffer?: ArrayBuffer;
  size?: number;
  kind?: EncapsulationKind;
};

const textEncoder = new TextEncoder();

export class CdrWriter {
  static DEFAULT_CAPACITY = 16;
  static BUFFER_COPY_THRESHOLD = 10;

  #littleEndian: boolean;
  #hostLittleEndian: boolean;
  #isCDR2: boolean;
  #eightByteAlignment: number; // Alignment for 64-bit values, 4 on CDR2 8 on CDR1
  #buffer: ArrayBuffer;
  #array: Uint8Array;
  #view: DataView;
  #offset: number;
  /** Origin offset into stream used for alignment */
  #origin: number;

  get data(): Uint8Array {
    return new Uint8Array(this.#buffer, 0, this.#offset);
  }

  get size(): number {
    return this.#offset;
  }

  get kind(): EncapsulationKind {
    return this.#view.getUint8(1) as EncapsulationKind;
  }

  constructor(options: CdrWriterOpts = {}) {
    if (options.buffer != undefined) {
      this.#buffer = options.buffer;
    } else if (options.size != undefined) {
      this.#buffer = new ArrayBuffer(options.size);
    } else {
      this.#buffer = new ArrayBuffer(CdrWriter.DEFAULT_CAPACITY);
    }

    const kind = options.kind ?? EncapsulationKind.CDR_LE;

    const { isCDR2, littleEndian } = getEncapsulationKindInfo(kind);
    this.#isCDR2 = isCDR2;
    this.#littleEndian = littleEndian;
    this.#hostLittleEndian = !isBigEndian();
    this.#eightByteAlignment = isCDR2 ? 4 : 8;
    this.#array = new Uint8Array(this.#buffer);
    this.#view = new DataView(this.#buffer);

    // Write the Representation Id and Offset fields
    this.#resizeIfNeeded(4);
    this.#view.setUint8(0, 0); // Upper bits of EncapsulationKind, unused
    this.#view.setUint8(1, kind);
    // The RTPS specification does not define any settings for the 2 byte
    // options field and further states that a receiver should not interpret it
    // when it reads the options field
    this.#view.setUint16(2, 0, false);
    this.#offset = 4;
    this.#origin = 4;
  }

  int8(value: number): this {
    this.#resizeIfNeeded(1);
    this.#view.setInt8(this.#offset, value);
    this.#offset += 1;
    return this;
  }

  uint8(value: number): this {
    this.#resizeIfNeeded(1);
    this.#view.setUint8(this.#offset, value);
    this.#offset += 1;
    return this;
  }

  int16(value: number): this {
    this.align(2);
    this.#view.setInt16(this.#offset, value, this.#littleEndian);
    this.#offset += 2;
    return this;
  }

  uint16(value: number): this {
    this.align(2);
    this.#view.setUint16(this.#offset, value, this.#littleEndian);
    this.#offset += 2;
    return this;
  }

  int32(value: number): this {
    this.align(4);
    this.#view.setInt32(this.#offset, value, this.#littleEndian);
    this.#offset += 4;
    return this;
  }

  uint32(value: number): this {
    this.align(4);
    this.#view.setUint32(this.#offset, value, this.#littleEndian);
    this.#offset += 4;
    return this;
  }

  int64(value: bigint): this {
    this.align(this.#eightByteAlignment, 8);
    this.#view.setBigInt64(this.#offset, value, this.#littleEndian);
    this.#offset += 8;
    return this;
  }

  uint64(value: bigint): this {
    this.align(this.#eightByteAlignment, 8);
    this.#view.setBigUint64(this.#offset, value, this.#littleEndian);
    this.#offset += 8;
    return this;
  }

  uint16BE(value: number): this {
    this.align(2);
    this.#view.setUint16(this.#offset, value, false);
    this.#offset += 2;
    return this;
  }

  uint32BE(value: number): this {
    this.align(4);
    this.#view.setUint32(this.#offset, value, false);
    this.#offset += 4;
    return this;
  }

  uint64BE(value: bigint): this {
    this.align(this.#eightByteAlignment, 8);
    this.#view.setBigUint64(this.#offset, value, false);
    this.#offset += 8;
    return this;
  }

  float32(value: number): this {
    this.align(4);
    this.#view.setFloat32(this.#offset, value, this.#littleEndian);
    this.#offset += 4;
    return this;
  }

  float64(value: number): this {
    this.align(this.#eightByteAlignment, 8);
    this.#view.setFloat64(this.#offset, value, this.#littleEndian);
    this.#offset += 8;
    return this;
  }

  // writeLength optional because it could already be included in a header
  string(value: string, writeLength = true): this {
    const strlen = value.length;
    if (writeLength) {
      this.uint32(strlen + 1); // Add one for the null terminator
    }
    this.#resizeIfNeeded(strlen + 1);
    textEncoder.encodeInto(value, new Uint8Array(this.#buffer, this.#offset, strlen));
    this.#view.setUint8(this.#offset + strlen, 0);
    this.#offset += strlen + 1;
    return this;
  }

  /** Writes the delimiter header using object size
   * NOTE: changing endian-ness with a single CDR message is not supported
   */
  dHeader(objectSize: number): this {
    // DHEADER(O) = O.ssize
    const header = objectSize;
    this.uint32(header);

    return this;
  }

  /**
   * Writes the member header (EMHEADER)
   * Accomodates for PL_CDR and PL_CDR2 based on the CdrWriter constructor options
   *
   * @param mustUnderstand - Whether the member is required to be understood by the receiver
   * @param id - The member ID
   * @param objectSize - The size of the member in bytes
   * @param lengthCode - Optional length code for CDR2 emHeaders.
   * lengthCode values [5-7] allow the emHeader object size to take the place of the normally encoded member length.
   *
   * NOTE: Dynamically determines default value if not provided that does not affect serialization ie will use lengthCode values [0-4].
   *
   * From Extensible and Dynamic Topic Types in DDS-XTypes v1.3 @ `7.4.3.4.2`:
   * "EMHEADER1 with LC values 5 to 7 also affect the serialization/deserialization virtual machine in that they cause NEXTINT to be
   * reused also as part of the serialized member. This is useful because the serialization of certain members also starts with an
   * integer length, which would take exactly the same value as NEXTINT. Therefore the use of length codes 5 to 7 saves 4 bytes in
   * the serialization."
   * @returns - CdrWriter instance
   */
  emHeader(mustUnderstand: boolean, id: number, objectSize: number, lengthCode?: number): this {
    return this.#isCDR2
      ? this.#memberHeaderV2(mustUnderstand, id, objectSize, lengthCode as LengthCode)
      : this.#memberHeaderV1(mustUnderstand, id, objectSize);
  }

  #memberHeaderV1(mustUnderstand: boolean, id: number, objectSize: number): this {
    this.align(4);
    const mustUnderstandFlag = mustUnderstand ? 1 << 14 : 0;
    const shouldUseExtendedPID = id > 0x3f00 || objectSize > 0xffff;

    if (!shouldUseExtendedPID) {
      const idHeader = mustUnderstandFlag | id;
      this.uint16(idHeader);
      const objectSizeHeader = objectSize & 0xffff;
      this.uint16(objectSizeHeader);
    } else {
      const extendedHeader = mustUnderstandFlag | EXTENDED_PID;
      this.uint16(extendedHeader);
      this.uint16(8); // size of next two parameters
      this.uint32(id);
      this.uint32(objectSize);
    }

    this.#resetOrigin();

    return this;
  }

  /** Sets the #origin to the #offset (DDS-XTypes Spec: `PUSH(ORIGIN = 0)`)*/
  #resetOrigin() {
    this.#origin = this.#offset;
  }

  /** Writes the PID_SENTINEL value if encapsulation supports it*/
  sentinelHeader(): this {
    if (!this.#isCDR2) {
      this.align(4);
      this.uint16(SENTINEL_PID);
      this.uint16(0);
    }
    return this;
  }

  #memberHeaderV2(
    mustUnderstand: boolean,
    id: number,
    objectSize: number,
    lengthCode?: LengthCode,
  ): this {
    if (id > 0x0fffffff) {
      // first byte is used for M_FLAG and LC
      throw Error(`Member ID ${id} is too large. Max value is 268435455`);
    }
    // EMHEADER = (M_FLAG<<31) + (LC<<28) + M.id
    // M is the member of a structure
    // M_FLAG is the value of the Must Understand option for the member
    const mustUnderstandFlag = mustUnderstand ? 1 << 31 : 0;
    // LC is the value of the Length Code for the member.
    const finalLengthCode: LengthCode = lengthCode ?? getLengthCodeForObjectSize(objectSize);

    const header = mustUnderstandFlag | (finalLengthCode << 28) | id;

    this.uint32(header);

    switch (finalLengthCode) {
      case 0:
      case 1:
      case 2:
      case 3: {
        const shouldBeSize = lengthCodeToObjectSizes[finalLengthCode];
        if (objectSize !== shouldBeSize) {
          throw new Error(
            `Cannot write a length code ${finalLengthCode} header with an object size not equal to ${shouldBeSize}`,
          );
        }
        break;
      }
      // When the length code is > 3 the header is 8 bytes because of the NEXTINT value storing the object size
      case 4:
      case 5:
        this.uint32(objectSize);
        break;
      case 6:
        if (objectSize % 4 !== 0) {
          throw new Error(
            "Cannot write a length code 6 header with an object size that is not a multiple of 4",
          );
        }
        this.uint32(objectSize >> 2);
        break;
      case 7:
        if (objectSize % 8 !== 0) {
          throw new Error(
            "Cannot write a length code 7 header with an object size that is not a multiple of 8",
          );
        }
        this.uint32(objectSize >> 3);
        break;
      default:
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        throw new Error(`Unexpected length code ${finalLengthCode}`);
    }

    return this;
  }

  sequenceLength(value: number): this {
    return this.uint32(value);
  }

  int8Array(value: Int8Array | number[], writeLength?: boolean): this {
    if (writeLength === true) {
      this.sequenceLength(value.length);
    }
    this.#resizeIfNeeded(value.length);
    this.#array.set(value, this.#offset);
    this.#offset += value.length;
    return this;
  }

  uint8Array(value: Uint8Array | number[], writeLength?: boolean): this {
    if (writeLength === true) {
      this.sequenceLength(value.length);
    }
    this.#resizeIfNeeded(value.length);
    this.#array.set(value, this.#offset);
    this.#offset += value.length;
    return this;
  }

  int16Array(value: Int16Array | number[], writeLength?: boolean): this {
    if (writeLength === true) {
      this.sequenceLength(value.length);
    }
    if (
      value instanceof Int16Array &&
      this.#littleEndian === this.#hostLittleEndian &&
      value.length >= CdrWriter.BUFFER_COPY_THRESHOLD
    ) {
      this.align(value.BYTES_PER_ELEMENT, value.byteLength);
      this.#array.set(
        new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
        this.#offset,
      );
      this.#offset += value.byteLength;
    } else {
      for (const entry of value) {
        this.int16(entry);
      }
    }
    return this;
  }

  uint16Array(value: Uint16Array | number[], writeLength?: boolean): this {
    if (writeLength === true) {
      this.sequenceLength(value.length);
    }
    if (
      value instanceof Uint16Array &&
      this.#littleEndian === this.#hostLittleEndian &&
      value.length >= CdrWriter.BUFFER_COPY_THRESHOLD
    ) {
      this.align(value.BYTES_PER_ELEMENT, value.byteLength);
      this.#array.set(
        new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
        this.#offset,
      );
      this.#offset += value.byteLength;
    } else {
      for (const entry of value) {
        this.uint16(entry);
      }
    }
    return this;
  }

  int32Array(value: Int32Array | number[], writeLength?: boolean): this {
    if (writeLength === true) {
      this.sequenceLength(value.length);
    }
    if (
      value instanceof Int32Array &&
      this.#littleEndian === this.#hostLittleEndian &&
      value.length >= CdrWriter.BUFFER_COPY_THRESHOLD
    ) {
      this.align(value.BYTES_PER_ELEMENT, value.byteLength);
      this.#array.set(
        new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
        this.#offset,
      );
      this.#offset += value.byteLength;
    } else {
      for (const entry of value) {
        this.int32(entry);
      }
    }
    return this;
  }

  uint32Array(value: Uint32Array | number[], writeLength?: boolean): this {
    if (writeLength === true) {
      this.sequenceLength(value.length);
    }
    if (
      value instanceof Uint32Array &&
      this.#littleEndian === this.#hostLittleEndian &&
      value.length >= CdrWriter.BUFFER_COPY_THRESHOLD
    ) {
      this.align(value.BYTES_PER_ELEMENT, value.byteLength);
      this.#array.set(
        new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
        this.#offset,
      );
      this.#offset += value.byteLength;
    } else {
      for (const entry of value) {
        this.uint32(entry);
      }
    }
    return this;
  }

  int64Array(value: BigInt64Array | bigint[] | number[], writeLength?: boolean): this {
    if (writeLength === true) {
      this.sequenceLength(value.length);
    }
    if (
      value instanceof BigInt64Array &&
      this.#littleEndian === this.#hostLittleEndian &&
      value.length >= CdrWriter.BUFFER_COPY_THRESHOLD
    ) {
      this.align(value.BYTES_PER_ELEMENT, value.byteLength);
      this.#array.set(
        new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
        this.#offset,
      );
      this.#offset += value.byteLength;
    } else {
      for (const entry of value) {
        this.int64(BigInt(entry));
      }
    }
    return this;
  }

  uint64Array(value: BigUint64Array | bigint[] | number[], writeLength?: boolean): this {
    if (writeLength === true) {
      this.sequenceLength(value.length);
    }
    if (
      value instanceof BigUint64Array &&
      this.#littleEndian === this.#hostLittleEndian &&
      value.length >= CdrWriter.BUFFER_COPY_THRESHOLD
    ) {
      this.align(value.BYTES_PER_ELEMENT, value.byteLength);
      this.#array.set(
        new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
        this.#offset,
      );
      this.#offset += value.byteLength;
    } else {
      for (const entry of value) {
        this.uint64(BigInt(entry));
      }
    }
    return this;
  }

  float32Array(value: Float32Array | number[], writeLength?: boolean): this {
    if (writeLength === true) {
      this.sequenceLength(value.length);
    }
    if (
      value instanceof Float32Array &&
      this.#littleEndian === this.#hostLittleEndian &&
      value.length >= CdrWriter.BUFFER_COPY_THRESHOLD
    ) {
      this.align(value.BYTES_PER_ELEMENT, value.byteLength);
      this.#array.set(
        new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
        this.#offset,
      );
      this.#offset += value.byteLength;
    } else {
      for (const entry of value) {
        this.float32(entry);
      }
    }
    return this;
  }

  float64Array(value: Float64Array | number[], writeLength?: boolean): this {
    if (writeLength === true) {
      this.sequenceLength(value.length);
    }
    if (
      value instanceof Float64Array &&
      this.#littleEndian === this.#hostLittleEndian &&
      value.length >= CdrWriter.BUFFER_COPY_THRESHOLD
    ) {
      this.align(value.BYTES_PER_ELEMENT, value.byteLength);
      this.#array.set(
        new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
        this.#offset,
      );
      this.#offset += value.byteLength;
    } else {
      for (const entry of value) {
        this.float64(entry);
      }
    }
    return this;
  }

  /**
   * Calculate the capacity needed to hold the given number of aligned bytes,
   * resize if needed, and write padding bytes for alignment
   * @param size Byte width to align to. If the current #offset is 1 and `size`
   *   is 4, 3 bytes of padding will be written
   * @param bytesToWrite Optional, total amount of bytes that are intended to be
   *   written directly following the alignment. This can be used to avoid
   *   additional #buffer resizes in the case of writing large blocks of aligned
   *   data such as arrays
   */
  align(size: number, bytesToWrite: number = size): void {
    const alignment = (this.#offset - this.#origin) % size;
    const padding = alignment > 0 ? size - alignment : 0;
    this.#resizeIfNeeded(padding + bytesToWrite);
    // Write padding bytes
    this.#array.fill(0, this.#offset, this.#offset + padding);
    this.#offset += padding;
  }

  #resizeIfNeeded(additionalBytes: number): void {
    const capacity = this.#offset + additionalBytes;
    if (this.#buffer.byteLength < capacity) {
      const doubled = this.#buffer.byteLength * 2;
      const newCapacity = doubled > capacity ? doubled : capacity;
      this.#resize(newCapacity);
    }
  }

  #resize(capacity: number): void {
    if (this.#buffer.byteLength >= capacity) {
      return;
    }

    const buffer = new ArrayBuffer(capacity);
    const array = new Uint8Array(buffer);
    array.set(this.#array);
    this.#buffer = buffer;
    this.#array = array;
    this.#view = new DataView(buffer);
  }
}
