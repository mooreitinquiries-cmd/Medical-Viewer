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
    acquisitionTime: parseDicomTime(firstTag(tags, ['AcquisitionTime', '0008,0032'])),
    seriesTime: parseDicomTime(firstTag(tags, ['SeriesTime', '0008,0031'])),
    description: firstTag(tags, ['SeriesDescription', '0008,103e']),
  };
}

function buildInstanceOrdering(instance, seriesOrdering, fallbackIndex) {
  const tags = (instance && instance.MainDicomTags) || {};
  const imagePosition = parseDicomDecimalList(firstTag(tags, ['ImagePositionPatient', '0020,0032']));
  return {
    id: cleanText(instance && instance.ID),
    fallbackIndex: Number(fallbackIndex) || 0,
    series: seriesOrdering || buildSeriesOrdering(null, 0),
    temporalPosition: firstNumber(tags, ['TemporalPositionIdentifier', '0020,0100']),
    instanceNumber: firstNumber(tags, ['InstanceNumber', '0020,0013']),
    imagePositionZ: imagePosition.length >= 3 ? imagePosition[2] : null,
    sliceLocation: firstNumber(tags, ['SliceLocation', '0020,1041']),
    acquisitionNumber: firstNumber(tags, ['AcquisitionNumber', '0020,0012']),
    acquisitionTime: parseDicomTime(firstTag(tags, ['AcquisitionTime', '0008,0032'])),
    contentTime: parseDicomTime(firstTag(tags, ['ContentTime', '0008,0033'])),
  };
}

function compareSeriesOrdering(left, right) {
  return (
    compareNullable(left.seriesNumber, right.seriesNumber) ||
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
    compareNullable(left.instanceNumber, right.instanceNumber) ||
    compareNullable(left.imagePositionZ, right.imagePositionZ) ||
    compareNullable(left.sliceLocation, right.sliceLocation) ||
    compareNullable(left.acquisitionNumber, right.acquisitionNumber) ||
    compareNullable(left.acquisitionTime, right.acquisitionTime) ||
    compareNullable(left.contentTime, right.contentTime) ||
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
