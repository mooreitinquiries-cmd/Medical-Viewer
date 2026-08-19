function cleanText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function firstTag(tags, names) {
  for (const name of names) {
    const value = tags && tags[name];
    if (value !== undefined && value !== null && cleanText(value)) {
      return cleanText(value);
    }
  }
  return '';
}

function firstNumber(tags, names) {
  const raw = firstTag(tags, names);
  if (!raw) return null;
  const value = Number(String(raw).split('\\')[0]);
  return Number.isFinite(value) ? value : null;
}

function firstIntegerFromUid(tags, names) {
  const raw = firstTag(tags, names);
  if (!raw) return null;
  const parts = String(raw)
    .split('.')
    .map(function (part) {
      return Number(part);
    })
    .filter(function (part) {
      return Number.isFinite(part);
    });
  if (parts.length === 0) return null;
  return parts[parts.length - 1];
}

function parseDicomDecimalList(value) {
  return cleanText(value)
    .split('\\')
    .map(function (part) {
      const parsed = Number(part);
      return Number.isFinite(parsed) ? parsed : null;
    })
    .filter(function (part) {
      return part !== null;
    });
}

function parseDicomTime(value) {
  const text = cleanText(value).replace(/[^0-9.]/g, '');
  if (!text) return null;
  const hours = Number(text.slice(0, 2) || 0);
  const minutes = Number(text.slice(2, 4) || 0);
  const seconds = Number(text.slice(4) || 0);
  const total = hours * 3600 + minutes * 60 + seconds;
  return Number.isFinite(total) ? total : null;
}

function parseDicomDate(value) {
  const text = cleanText(value).replace(/[^0-9]/g, '');
  if (text.length < 8) return null;
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(4, 6));
  const day = Number(text.slice(6, 8));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return year * 10000 + month * 100 + day;
}

function vectorCross(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length < 3 || right.length < 3) {
    return null;
  }
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function vectorDot(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length < 3 || right.length < 3) {
    return null;
  }
  const value = left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
  return Number.isFinite(value) ? value : null;
}

function imagePositionProjection(tags) {
  const position = parseDicomDecimalList(firstTag(tags, ['ImagePositionPatient', '0020,0032']));
  if (position.length < 3) return null;

  const orientation = parseDicomDecimalList(firstTag(tags, ['ImageOrientationPatient', '0020,0037']));
  if (orientation.length >= 6) {
    const row = orientation.slice(0, 3);
    const column = orientation.slice(3, 6);
    const normal = vectorCross(row, column);
    const projection = vectorDot(position, normal);
    if (Number.isFinite(projection)) return projection;
  }

  return position[2];
}

function compareNullable(left, right) {
  const leftMissing = left === null || left === undefined || Number.isNaN(left);
  const rightMissing = right === null || right === undefined || Number.isNaN(right);
  if (leftMissing && rightMissing) return 0;
  if (leftMissing) return 1;
  if (rightMissing) return -1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareText(left, right) {
  return cleanText(left).localeCompare(cleanText(right), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function buildSeriesOrdering(series, fallbackIndex) {
  const tags = (series && series.MainDicomTags) || {};
  return {
    id: cleanText(series && series.ID),
    fallbackIndex: Number(fallbackIndex) || 0,
    seriesNumber: firstNumber(tags, ['SeriesNumber', '0020,0011']),
    acquisitionDate: parseDicomDate(firstTag(tags, ['AcquisitionDate', '0008,0022'])),
    seriesDate: parseDicomDate(firstTag(tags, ['SeriesDate', '0008,0021'])),
    acquisitionTime: parseDicomTime(firstTag(tags, ['AcquisitionTime', '0008,0032'])),
    seriesTime: parseDicomTime(firstTag(tags, ['SeriesTime', '0008,0031'])),
    description: firstTag(tags, ['SeriesDescription', '0008,103e']),
  };
}

function buildInstanceOrdering(instance, seriesOrdering, fallbackIndex) {
  const tags = (instance && instance.MainDicomTags) || {};
  return {
    id: cleanText(instance && instance.ID),
    fallbackIndex: Number(fallbackIndex) || 0,
    series: seriesOrdering || buildSeriesOrdering(null, 0),
    temporalPosition: firstNumber(tags, ['TemporalPositionIdentifier', '0020,0100']),
    inStackPosition: firstNumber(tags, ['InStackPositionNumber', '0020,9057']),
    dimensionIndex: firstNumber(tags, ['DimensionIndexValues', '0020,9157']),
    instanceNumber: firstNumber(tags, ['InstanceNumber', '0020,0013']),
    imagePositionProjection: imagePositionProjection(tags),
    sliceLocation: firstNumber(tags, ['SliceLocation', '0020,1041']),
    acquisitionNumber: firstNumber(tags, ['AcquisitionNumber', '0020,0012']),
    acquisitionDate: parseDicomDate(firstTag(tags, ['AcquisitionDate', '0008,0022'])),
    contentDate: parseDicomDate(firstTag(tags, ['ContentDate', '0008,0023'])),
    acquisitionTime: parseDicomTime(firstTag(tags, ['AcquisitionTime', '0008,0032'])),
    contentTime: parseDicomTime(firstTag(tags, ['ContentTime', '0008,0033'])),
    sopInstanceTail: firstIntegerFromUid(tags, ['SOPInstanceUID', '0008,0018']),
  };
}

function compareSeriesOrdering(left, right) {
  return (
    compareNullable(left.seriesNumber, right.seriesNumber) ||
    compareNullable(left.acquisitionDate, right.acquisitionDate) ||
    compareNullable(left.seriesDate, right.seriesDate) ||
    compareNullable(left.acquisitionTime, right.acquisitionTime) ||
    compareNullable(left.seriesTime, right.seriesTime) ||
    compareText(left.description, right.description) ||
    compareText(left.id, right.id) ||
    left.fallbackIndex - right.fallbackIndex
  );
}

function compareInstanceOrdering(left, right) {
  return (
    compareSeriesOrdering(left.series, right.series) ||
    compareNullable(left.temporalPosition, right.temporalPosition) ||
    compareNullable(left.inStackPosition, right.inStackPosition) ||
    compareNullable(left.dimensionIndex, right.dimensionIndex) ||
    compareNullable(left.imagePositionProjection, right.imagePositionProjection) ||
    compareNullable(left.sliceLocation, right.sliceLocation) ||
    compareNullable(left.acquisitionNumber, right.acquisitionNumber) ||
    compareNullable(left.acquisitionDate, right.acquisitionDate) ||
    compareNullable(left.contentDate, right.contentDate) ||
    compareNullable(left.acquisitionTime, right.acquisitionTime) ||
    compareNullable(left.contentTime, right.contentTime) ||
    compareNullable(left.instanceNumber, right.instanceNumber) ||
    compareNullable(left.sopInstanceTail, right.sopInstanceTail) ||
    compareText(left.id, right.id) ||
    left.fallbackIndex - right.fallbackIndex
  );
}

function sortDicomSeries(seriesItems) {
  return (Array.isArray(seriesItems) ? seriesItems : [])
    .map(function (series, index) {
      return {
        series: series,
        ordering: buildSeriesOrdering(series, index),
      };
    })
    .sort(function (left, right) {
      return compareSeriesOrdering(left.ordering, right.ordering);
    });
}

function sortDicomInstances(instanceItems, seriesOrdering) {
  return (Array.isArray(instanceItems) ? instanceItems : [])
    .map(function (instance, index) {
      return {
        instance: instance,
        ordering: buildInstanceOrdering(instance, seriesOrdering, index),
      };
    })
    .sort(function (left, right) {
      return compareInstanceOrdering(left.ordering, right.ordering);
    });
}

module.exports = {
  buildSeriesOrdering,
  buildInstanceOrdering,
  sortDicomSeries,
  sortDicomInstances,
};
