const assert = require('assert');
const {
  buildSeriesOrdering,
  sortDicomSeries,
  sortDicomInstances,
} = require('../lib/dicomOrdering');

const series = sortDicomSeries([
  {
    ID: 'series-10',
    MainDicomTags: {
      SeriesNumber: '10',
      SeriesDescription: 'Later',
    },
  },
  {
    ID: 'series-2',
    MainDicomTags: {
      SeriesNumber: '2',
      SeriesDescription: 'Earlier',
    },
  },
]);

assert.deepStrictEqual(
  series.map((item) => item.series.ID),
  ['series-2', 'series-10']
);

const ordering = buildSeriesOrdering(
  {
    ID: 'series-1',
    MainDicomTags: {
      SeriesNumber: '1',
    },
  },
  0
);

const instances = sortDicomInstances(
  [
    {
      ID: 'instance-10',
      MainDicomTags: {
        InstanceNumber: '10',
        ImagePositionPatient: '0\\0\\10',
      },
    },
    {
      ID: 'instance-2',
      MainDicomTags: {
        InstanceNumber: '2',
        ImagePositionPatient: '0\\0\\2',
      },
    },
    {
      ID: 'instance-1',
      MainDicomTags: {
        InstanceNumber: '1',
        ImagePositionPatient: '0\\0\\1',
      },
    },
  ],
  ordering
);

assert.deepStrictEqual(
  instances.map((item) => item.instance.ID),
  ['instance-1', 'instance-2', 'instance-10']
);

const positionedInstances = sortDicomInstances(
  [
    {
      ID: 'slice-high',
      MainDicomTags: {
        InstanceNumber: '1',
        ImagePositionPatient: '0\\0\\12',
      },
    },
    {
      ID: 'slice-low',
      MainDicomTags: {
        InstanceNumber: '99',
        ImagePositionPatient: '0\\0\\3',
      },
    },
  ],
  ordering
);

assert.deepStrictEqual(
  positionedInstances.map((item) => item.instance.ID),
  ['slice-low', 'slice-high']
);

const orientedInstances = sortDicomInstances(
  [
    {
      ID: 'sagittal-later',
      MainDicomTags: {
        ImageOrientationPatient: '0\\1\\0\\0\\0\\1',
        ImagePositionPatient: '9\\0\\0',
        InstanceNumber: '1',
      },
    },
    {
      ID: 'sagittal-earlier',
      MainDicomTags: {
        ImageOrientationPatient: '0\\1\\0\\0\\0\\1',
        ImagePositionPatient: '2\\0\\0',
        InstanceNumber: '2',
      },
    },
  ],
  ordering
);

assert.deepStrictEqual(
  orientedInstances.map((item) => item.instance.ID),
  ['sagittal-earlier', 'sagittal-later']
);

const temporalInstances = sortDicomInstances(
  [
    {
      ID: 'phase-2-slice-1',
      MainDicomTags: {
        TemporalPositionIdentifier: '2',
        ImagePositionPatient: '0\\0\\1',
      },
    },
    {
      ID: 'phase-1-slice-5',
      MainDicomTags: {
        TemporalPositionIdentifier: '1',
        ImagePositionPatient: '0\\0\\5',
      },
    },
  ],
  ordering
);

assert.deepStrictEqual(
  temporalInstances.map((item) => item.instance.ID),
  ['phase-1-slice-5', 'phase-2-slice-1']
);

console.log('dicom ordering regression passed');
